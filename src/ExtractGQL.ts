// This file implements the extractgql CLI tool.
import crypto = require("crypto");
import fs = require("fs");
import path = require("path");
const { promisify } = require("util");

import {
  parse,
  DocumentNode,
  OperationDefinitionNode,
  FragmentDefinitionNode,
  print,
  DefinitionNode,
  separateOperations
} from "graphql";

import {
  getOperationDefinitions,
  getFragmentNames,
  isFragmentDefinition,
  isOperationDefinition
} from "./extractFromAST";

import {
  findTaggedTemplateLiteralsInJS,
  eliminateInterpolations
} from "./extractFromJS";

import {
  getQueryKey,
  getQueryDocumentKey,
  sortFragmentsByName,
  applyQueryTransformers,
  TransformedQueryWithId,
  OutputMap,
  QueryTransformer
} from "./common";

import { addTypenameTransformer } from "./queryTransformers";

import _ = require("lodash");
import redis = require("redis");

export type HashTypeOption = "md5" | "sha1" | "sha256" | "sequential" | "uuid";

export const HASH_TYPES: HashTypeOption[] = [
  "md5",
  "sha1",
  "sha256",
  "sequential",
  "uuid"
];

export type ExtractGQLOptions = {
  inputFilePath: string;
  outputFilePath?: string;
  queryTransformers?: QueryTransformer[];
  extension?: string;
  inJsCode?: boolean;
  hashType?: HashTypeOption;
  redisUrl?: string;
  redisPrefix?: string;
};

export class ExtractGQL {
  public inputFilePath: string;
  public outputFilePath: string;

  // Starting point for monotonically increasing query ids.
  public queryId: number = 0;

  // List of query transformers that a query is put through (left to right)
  // before being written as a transformedQuery within the OutputMap.
  public queryTransformers: QueryTransformer[] = [];

  // The file extension to load queries from
  public extension: string;

  // Whether to look for standalone .graphql files or template literals in JavaScript code
  public inJsCode: boolean = false;

  // What type of hash/id should be used
  public hashType: HashTypeOption;

  // The template literal tag for GraphQL queries in JS code
  public literalTag: string = "gql";

  // The redis host including port separated by colon
  public redisUrl: string;

  // The redis password
  public redisPassword: string;

  // The redis prefix (namespace)
  public redisPrefix: string;

  // Given a file path, this returns the extension of the file within the
  // file path.
  public static getFileExtension(filePath: string): string {
    const pieces = path.basename(filePath).split(".");
    if (pieces.length <= 1) {
      return "";
    }
    return pieces[pieces.length - 1];
  }

  // Reads a file into a string.
  public static readFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      fs.readFile(filePath, "utf8", (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  // Checks if a given path points to a directory.
  public static isDirectory(path: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      fs.stat(path, (err, stats) => {
        if (err) {
          reject(err);
        } else {
          resolve(stats.isDirectory());
        }
      });
    });
  }

  constructor({
    inputFilePath,
    outputFilePath = "extracted_queries.json",
    queryTransformers = [],
    extension = "graphql",
    inJsCode = false,
    hashType = "sequential",
    redisUrl,
    redisPrefix = "graphqlQueries"
  }: ExtractGQLOptions) {
    this.inputFilePath = inputFilePath;
    this.outputFilePath = outputFilePath;
    this.queryTransformers = queryTransformers;
    this.extension = extension;
    this.inJsCode = inJsCode;
    this.hashType = hashType;
    this.redisUrl = redisUrl;
    this.redisPrefix = redisPrefix;
  }

  // Add a query transformer to the end of the list of query transformers.
  public addQueryTransformer(queryTransformer: QueryTransformer) {
    this.queryTransformers.push(queryTransformer);
  }

  // Applies this.queryTransformers to a query document.
  public applyQueryTransformers(document: DocumentNode) {
    return applyQueryTransformers(document, this.queryTransformers);
  }

  // Just calls getQueryKey with this.queryTransformers as its set of
  // query transformers and returns a serialization of the query.
  public getQueryKey(definition: OperationDefinitionNode): string {
    return getQueryKey(definition, this.queryTransformers);
  }

  // Just calls getQueryDocumentKey with this.queryTransformers as its
  // set of query transformers and returns a serialization of the query.
  public getQueryDocumentKey(document: DocumentNode): string {
    return getQueryDocumentKey(document, this.queryTransformers);
  }

  // Create an OutputMap from a GraphQL document that may contain
  // queries, mutations and fragments.
  public createMapFromDocument(document: DocumentNode): OutputMap {
    const transformedDocument = this.applyQueryTransformers(document);
    const queryDefinitions = getOperationDefinitions(transformedDocument);
    const result: OutputMap = {};
    queryDefinitions.forEach(transformedDefinition => {
      const transformedQueryWithFragments = this.getQueryFragments(
        transformedDocument,
        transformedDefinition
      );
      transformedQueryWithFragments.definitions.unshift(transformedDefinition);
      const docQueryKey = this.getQueryDocumentKey(
        transformedQueryWithFragments
      );
      result[docQueryKey] = this.getQueryId(docQueryKey);
    });
    return result;
  }

  // Given the path to a particular `.graphql` file, read it, extract the queries
  // and return the promise to an OutputMap. Used primarily for unit tests.
  public processGraphQLFile(graphQLFile: string): Promise<OutputMap> {
    return new Promise<OutputMap>((resolve, reject) => {
      ExtractGQL.readFile(graphQLFile)
        .then(fileContents => {
          const graphQLDocument = parse(fileContents);

          resolve(this.createMapFromDocument(graphQLDocument));
        })
        .catch(err => {
          reject(err);
        });
    });
  }

  // Creates an OutputMap from an array of GraphQL documents read as strings.
  public createOutputMapFromString(docString: string): OutputMap {
    const doc = parse(docString);
    const docMap = separateOperations(doc);

    const resultMaps = Object.keys(docMap).map(operationName => {
      const document = docMap[operationName];
      return this.createMapFromDocument(document);
    });

    return _.merge({} as OutputMap, ...resultMaps) as OutputMap;
  }

  public readGraphQLFile(graphQLFile: string): Promise<string> {
    return ExtractGQL.readFile(graphQLFile);
  }

  public readInputFile(inputFile: string): Promise<string> {
    return Promise.resolve().then(() => {
      const extension = ExtractGQL.getFileExtension(inputFile);

      if (extension === this.extension) {
        if (this.inJsCode) {
          // Read from a JS file
          return ExtractGQL.readFile(inputFile).then(result => {
            const literalContents = findTaggedTemplateLiteralsInJS(
              result,
              this.literalTag
            );
            const noInterps = literalContents.map(eliminateInterpolations);
            const joined = noInterps.join("\n");
            return joined;
          });
        } else {
          return this.readGraphQLFile(inputFile);
        }
      } else {
        return "";
      }
    });
  }

  // Processes an input path, which may be a path to a GraphQL file
  // or a directory containing GraphQL files. Creates an OutputMap
  // instance from these files.
  public processInputPath(inputPath: string): Promise<OutputMap> {
    return new Promise<OutputMap>((resolve, reject) => {
      this.readInputPath(inputPath)
        .then((docString: string) => {
          resolve(this.createOutputMapFromString(docString));
        })
        .catch(err => {
          reject(err);
        });
    });
  }

  public readInputPath(inputPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      ExtractGQL.isDirectory(inputPath).then(isDirectory => {
        if (isDirectory) {
          console.log(`Crawling ${inputPath}...`);
          // Recurse over the files within this directory.
          fs.readdir(inputPath, (err, items) => {
            if (err) {
              reject(err);
            }
            const promises: Promise<string>[] = items.map(item => {
              return this.readInputPath(inputPath + "/" + item);
            });

            Promise.all(promises).then((queryStrings: string[]) => {
              resolve(queryStrings.reduce((x, y) => x + y, ""));
            });
          });
        } else {
          this.readInputFile(inputPath)
            .then((result: string) => {
              resolve(result);
            })
            .catch(err => {
              console.log(`Error occurred in processing path ${inputPath}: `);
              console.log(err.message);
              reject(err);
            });
        }
      });
    });
  }

  // Takes a document and a query definition contained within that document. Then, extracts
  // the fragments that the query depends on from the document and returns a document containing
  // only those fragments.
  public getQueryFragments(
    document: DocumentNode,
    queryDefinition: OperationDefinitionNode
  ): DocumentNode {
    const queryFragmentNames = getFragmentNames(
      queryDefinition.selectionSet,
      document
    );
    const retDocument: DocumentNode = {
      kind: "Document",
      definitions: []
    };

    const reduceQueryDefinitions = (
      carry: FragmentDefinitionNode[],
      definition: DefinitionNode
    ) => {
      const definitionName = (definition as (
        | FragmentDefinitionNode
        | OperationDefinitionNode)).name;
      if (
        isFragmentDefinition(definition) &&
        queryFragmentNames[definitionName.value] === 1
      ) {
        const definitionExists =
          carry.findIndex(
            (value: FragmentDefinitionNode) =>
              value.name.value === definitionName.value
          ) !== -1;

        // If this definition doesn't exist yet, add it.
        if (!definitionExists) {
          return [...carry, definition];
        }
      }

      return carry;
    };

    retDocument.definitions = document.definitions
      .reduce(reduceQueryDefinitions, [] as FragmentDefinitionNode[])
      .sort(sortFragmentsByName);

    return retDocument;
  }

  // Returns unique query ids.
  public getQueryId(documentQuery: string) {
    switch (this.hashType) {
      case "md5":
        return crypto
          .createHash("md5")
          .update(documentQuery, "utf8")
          .digest("hex");
      case "sha1":
        return crypto
          .createHash("sha1")
          .update(documentQuery, "utf8")
          .digest("hex");
      case "sha256":
        return crypto
          .createHash("sha256")
          .update(documentQuery, "utf8")
          .digest("hex");
      case "uuid":
        const randomBytes = crypto.randomBytes(32).toString("hex");
        return (
          randomBytes.substr(0, 8) +
          "-" +
          randomBytes.substr(8, 4) +
          "-" +
          randomBytes.substr(12, 4) +
          "-" +
          randomBytes.substr(16, 4) +
          "-" +
          randomBytes.substr(20, 12)
        );
      case "sequential":
      default:
        this.queryId += 1;
        return this.queryId;
    }
  }

  // Writes an OutputMap to a given file path.
  public writeOutputMap(
    outputMap: OutputMap,
    outputFilePath: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.open(outputFilePath, "w+", (openErr, fd) => {
        if (openErr) {
          reject(openErr);
        }
        fs.write(fd, JSON.stringify(outputMap), (writeErr, written, str) => {
          if (writeErr) {
            reject(writeErr);
          }
          resolve();
        });
      });
    });
  }

  public async pushToRedis(outputMap: OutputMap): Promise<void> {
    console.log("Pushing to redis...");
    const mapToPush = _.invert(outputMap);
    const client = redis.createClient({
      url: this.redisUrl,
      prefix: `${this.redisPrefix}:`
    });

    client.on("error", function(err) {
      console.error("Error pushing to redis", err.message);
      throw err;
    });

    const setAsync = promisify(client.set).bind(client);

    const promises = [];
    for (let [key, value] of Object.entries(mapToPush)) {
      console.log("\tPushing query with id:", key);
      promises.push(setAsync(key, value));
    }

    await Promise.all(promises);

    console.log("All queries pushed");
    client.quit();
  }

  // Extracts GraphQL queries from this.inputFilePath and produces
  // an output JSON file in this.outputFilePath.
  public extract() {
    this.processInputPath(this.inputFilePath)
      .then((outputMap: OutputMap) => {
        this.writeOutputMap(outputMap, this.outputFilePath)
          .then(() => {
            console.log(`Wrote output file to ${this.outputFilePath}.`);
          })
          .then(() => {
            if (this.redisUrl) {
              this.pushToRedis(outputMap);
            }
          })
          .catch(err => {
            console.log(
              `Unable to process ouput path ${
                this.outputFilePath
              }. Error message: `
            );
            console.log(`${err.message}`);
          });
      })
      .catch(err => {
        console.log(
          `Unable to process input path ${this.inputFilePath}. Error message: `
        );
        console.log(`${err.message}`);
      });
  }
}

// Type for the argument structure provided by the "yargs" library.
export interface YArgsv {
  _: string[];
  [key: string]: any;
}

// Main driving method for the command line tool
export const main = (argv: YArgsv) => {
  // These are the unhypenated arguments that yargs does not process
  // further.
  const args: string[] = argv._;
  let inputFilePath: string;
  let outputFilePath: string;
  const queryTransformers: QueryTransformer[] = [];

  if (args.length < 1) {
    console.log("Usage: persistgraphql input_file [output_file]");
  } else if (args.length === 1) {
    inputFilePath = args[0];
  } else {
    inputFilePath = args[0];
    outputFilePath = args[1];
  }

  // Check if we are passed "--add_typename", if we are, we have to
  // apply the typename query transformer.
  if (argv["add_typename"]) {
    console.log("Using the add-typename query transformer.");
    queryTransformers.push(addTypenameTransformer);
  }

  const options: ExtractGQLOptions = {
    inputFilePath,
    outputFilePath,
    queryTransformers
  };

  if (argv["js"]) {
    options.inJsCode = true;
  }

  if (argv["extension"]) {
    options.extension = argv["extension"];
  }

  if (argv["hash"]) {
    if (HASH_TYPES.indexOf(argv["hash"]) === -1) {
      console.log(
        `Invalid hash operation. Must be one of [${HASH_TYPES.join(", ")}]`
      );
      process.exit(1);
    }
    options.hashType = argv["hash"];
  }

  if (argv["redisUrl"]) {
    options.redisUrl = argv["redisUrl"];
  }

  if (argv["redisPrefix"]) {
    options.redisPrefix = argv["redisPrefix"];
  }

  new ExtractGQL(options).extract();
};
