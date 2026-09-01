import { createOpenAI } from "@ai-sdk/openai";
import {
  API_VERSION,
  createOpenRpcDocument,
  methods,
  type RpcMethod,
  rpcRequestSchema,
  SEARCHGRES_FAILURE_CODE,
  type StoredRecord,
} from "@searchgres/protocol";
import postgres, { type Sql } from "postgres";
import {
  type StoredRecord as CoreStoredRecord,
  type EmbeddingWorker,
  type Index,
  InvalidConfigError,
  noTruncation,
  openIndex,
  type PatchInput,
  SearchgresError,
  type SearchOptions,
  type SearchResult,
  type Truncator,
  truncateBytes,
  truncateCharacters,
  type UpsertRecord,
  type UpsertResult,
} from "searchgres";
import type { z } from "zod";
import { readRequiredEnvironment, type ServerConfig } from "./config.ts";
import { TokenizerPool } from "./tokenizer-pool.ts";

const SERVER_VERSION = "0.0.0";

type RpcId = string | number | null;

export interface RunningServer {
  readonly url: URL;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  readonly readOnly?: boolean;
}

const MUTATING_METHODS = new Set<RpcMethod>([
  "searchgres.v1.record.upsert",
  "searchgres.v1.record.upsertMany",
  "searchgres.v1.record.insert",
  "searchgres.v1.record.insertMany",
  "searchgres.v1.record.patch",
  "searchgres.v1.record.delete",
  "searchgres.v1.record.deleteByName",
  "searchgres.v1.tree.move",
  "searchgres.v1.tree.copy",
  "searchgres.v1.tree.delete",
]);

export async function startServer(
  config: ServerConfig,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const databaseUrl = readRequiredEnvironment(config.database.urlEnv);
  const apiSql = createPool(databaseUrl, config, "api");
  const workerSql = createPool(databaseUrl, config, "worker");

  let apiIndex: Index | undefined;
  let worker: EmbeddingWorker | undefined;
  let tokenizerPool: TokenizerPool | undefined;
  try {
    const embedding = createEmbeddingModel(config);
    const truncation = createTruncator(config);
    tokenizerPool = truncation.tokenizerPool;
    const { truncate } = truncation;
    apiIndex = await openIndex(apiSql, config.index.schema, {
      embedding,
      truncate,
    });
    if (!options.readOnly) {
      const workerIndex = await openIndex(workerSql, config.index.schema, {
        embedding,
        truncate,
      });
      worker = workerIndex.startEmbeddingWorker({
        intervalMs: config.index.worker.interval,
        batchSize: config.index.worker.batchSize,
      });
    }

    const handler = createRequestHandler(
      apiIndex,
      options.readOnly ?? false,
      config.server.maxRequestBodyBytes,
    );
    const server = Bun.serve({
      hostname: config.server.listen.host,
      port: config.server.listen.port,
      fetch: handler,
    });
    return {
      url: server.url,
      async stop() {
        server.stop(true);
        await worker?.stop();
        await tokenizerPool?.shutdown();
        await Promise.all([apiSql.end(), workerSql.end()]);
      },
    };
  } catch (error) {
    await worker?.stop();
    await tokenizerPool?.shutdown();
    await Promise.allSettled([apiSql.end(), workerSql.end()]);
    throw error;
  }
}

function createPool(
  url: string,
  config: ServerConfig,
  role: "api" | "worker",
): Sql {
  const settings = config.database[role];
  return postgres(url, {
    max: settings.pool.max,
    idle_timeout: settings.pool.idleReap / 1_000,
    max_lifetime: settings.pool.maxLifetime / 1_000,
    connect_timeout: settings.pool.connectTimeout / 1_000,
    onnotice: () => {},
    connection: {
      application_name: `searchgres-${role}`,
      statement_timeout: settings.session.statementTimeout,
      lock_timeout: settings.session.lockTimeout,
      transaction_timeout: settings.session.transactionTimeout,
      idle_in_transaction_session_timeout:
        settings.session.idleInTransactionSessionTimeout,
    },
  });
}

function createEmbeddingModel(config: ServerConfig) {
  const apiKey = config.index.embedding.apiKeyEnv
    ? readRequiredEnvironment(config.index.embedding.apiKeyEnv)
    : "searchgres";
  const provider = createOpenAI({
    apiKey,
    ...(config.index.embedding.baseUrl
      ? { baseURL: config.index.embedding.baseUrl }
      : {}),
  });
  return provider.embedding(config.index.embedding.model);
}

function createTruncator(config: ServerConfig): {
  readonly truncate: Truncator;
  readonly tokenizerPool?: TokenizerPool;
} {
  const truncate = config.index.truncate;
  switch (truncate.kind) {
    case "none":
      return { truncate: noTruncation };
    case "characters":
      return { truncate: truncateCharacters(truncate.max) };
    case "bytes":
      return { truncate: truncateBytes(truncate.max) };
    case "tokens": {
      const tokenizerPool = new TokenizerPool({
        preset: truncate.tokenizer,
        maxTokens: truncate.maxTokens,
        ...(truncate.threads === undefined
          ? {}
          : { threads: truncate.threads }),
      });
      return {
        truncate: (text) => tokenizerPool.truncate(text),
        tokenizerPool,
      };
    }
  }
}

function createRequestHandler(
  index: Index,
  readOnly: boolean,
  maxRequestBodyBytes: number,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/openrpc.json") {
      return Response.json(createOpenRpcDocument());
    }
    if (request.method !== "POST" || url.pathname !== "/rpc") {
      return new Response("Not found", { status: 404 });
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return new Response("Expected application/json", { status: 415 });
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxRequestBodyBytes
    ) {
      return requestTooLarge(maxRequestBodyBytes);
    }

    let body: unknown;
    try {
      const bytes = await readRequestBody(request, maxRequestBodyBytes);
      if (bytes === undefined) return requestTooLarge(maxRequestBodyBytes);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    return rpcResponse(
      await dispatch(index, body, readOnly, maxRequestBodyBytes),
    );
  };
}

async function dispatch(
  index: Index,
  body: unknown,
  readOnly: boolean,
  maxRequestBodyBytes: number,
): Promise<object> {
  const envelope = rpcRequestSchema.safeParse(body);
  if (!envelope.success) {
    return rpcError(null, -32600, "Invalid Request", {
      issues: issues(envelope.error),
    });
  }
  const { id, method, params } = envelope.data;
  if (!isRpcMethod(method)) {
    return rpcError(id, -32601, "Method not found");
  }

  if (readOnly && MUTATING_METHODS.has(method)) {
    return rpcError(id, SEARCHGRES_FAILURE_CODE, "Server is read-only", {
      searchgresCode: "READ_ONLY",
      type: "ReadOnlyError",
    });
  }

  const definition = methods[method];
  const parsed = definition.params.safeParse(params);
  if (!parsed.success) {
    return rpcError(id, -32602, "Invalid params", {
      issues: issues(parsed.error),
    });
  }

  try {
    const result = await invoke(
      index,
      method,
      parsed.data,
      readOnly,
      maxRequestBodyBytes,
    );
    const validated = definition.result.safeParse(result);
    if (!validated.success) {
      throw new Error(`Invalid handler result for ${method}`, {
        cause: validated.error,
      });
    }
    return { jsonrpc: "2.0", id, result: validated.data };
  } catch (error) {
    if (error instanceof SearchgresError) {
      return rpcError(id, SEARCHGRES_FAILURE_CODE, error.message, {
        searchgresCode: error.code,
        type: error.name,
        ...(error instanceof InvalidConfigError
          ? { issues: error.issues }
          : {}),
      });
    }
    return rpcError(id, -32603, "Internal error");
  }
}

async function invoke(
  index: Index,
  method: RpcMethod,
  params: unknown,
  readOnly: boolean,
  maxRequestBodyBytes: number,
): Promise<unknown> {
  switch (method) {
    case "rpc.discover":
      return createOpenRpcDocument();
    case "searchgres.v1.server.info":
      return {
        apiVersion: API_VERSION,
        serverVersion: SERVER_VERSION,
        maxRequestBodyBytes,
        capabilities: {
          semanticText: true,
          fulltext: true,
          userSuppliedVectors: false,
          workerManagedByServer: true,
          readOnly,
        },
      };
    case "searchgres.v1.record.upsert": {
      const input = methods[method].params.parse(params);
      const result = await index.upsert(input.record as UpsertRecord, {
        onConflict: input.onConflict,
      });
      return { result: mapUpsertResult(result) };
    }
    case "searchgres.v1.record.upsertMany": {
      const input = methods[method].params.parse(params);
      const results = await index.upsertMany(input.records as UpsertRecord[], {
        onConflict: input.onConflict,
      });
      return { results: results.map(mapUpsertResult) };
    }
    case "searchgres.v1.record.insert": {
      const input = methods[method].params.parse(params);
      return {
        result: mapUpsertResult(
          await index.insert(input.record as UpsertRecord),
        ),
      };
    }
    case "searchgres.v1.record.insertMany": {
      const input = methods[method].params.parse(params);
      const results = await index.insertMany(input.records as UpsertRecord[]);
      return { results: results.map(mapUpsertResult) };
    }
    case "searchgres.v1.record.get": {
      const input = methods[method].params.parse(params);
      return { record: mapStoredRecord(await index.get(input.id)) };
    }
    case "searchgres.v1.record.getByName": {
      const input = methods[method].params.parse(params);
      return {
        record: mapStoredRecord(await index.getByName(input.tree, input.name)),
      };
    }
    case "searchgres.v1.record.patch": {
      const input = methods[method].params.parse(params);
      return {
        record: mapStoredRecord(
          await index.patch(
            input.id,
            input.priorVersionHash,
            input.patch as PatchInput,
          ),
        ),
      };
    }
    case "searchgres.v1.record.delete": {
      const input = methods[method].params.parse(params);
      await index.delete(input.id);
      return {};
    }
    case "searchgres.v1.record.deleteByName": {
      const input = methods[method].params.parse(params);
      await index.deleteByName(input.tree, input.name);
      return {};
    }
    case "searchgres.v1.tree.move": {
      const input = methods[method].params.parse(params);
      return index.moveTree(
        input.source,
        input.destination,
        treeMutationOptions(input.options),
      );
    }
    case "searchgres.v1.tree.copy": {
      const input = methods[method].params.parse(params);
      return index.copyTree(
        input.source,
        input.destination,
        treeMutationOptions(input.options),
      );
    }
    case "searchgres.v1.tree.delete": {
      const input = methods[method].params.parse(params);
      return index.deleteTree(input.tree, treeMutationOptions(input.options));
    }
    case "searchgres.v1.tree.count": {
      const input = methods[method].params.parse(params);
      return index.countTree(
        input.selector,
        input.limit === undefined ? undefined : { limit: input.limit },
      );
    }
    case "searchgres.v1.tree.list": {
      const input = methods[method].params.parse(params);
      return { entries: await index.listTree(input.lquery) };
    }
    case "searchgres.v1.tree.view": {
      const input = methods[method].params.parse(params);
      return {
        entries: await index.treeView(
          input.tree,
          input.levels === undefined ? undefined : { levels: input.levels },
        ),
      };
    }
    case "searchgres.v1.search": {
      const input = methods[method].params.parse(params);
      const results = await index.search(input as SearchOptions);
      return { results: results.map(mapSearchResult) };
    }
  }
}

function treeMutationOptions(
  options: { readonly dryRun?: boolean | undefined } | undefined,
) {
  return options?.dryRun === undefined ? undefined : { dryRun: options.dryRun };
}

function isRpcMethod(value: string): value is RpcMethod {
  return Object.hasOwn(methods, value);
}

function mapUpsertResult(result: UpsertResult) {
  return { id: result.id, status: result.status };
}

function mapStoredRecord(record: CoreStoredRecord): StoredRecord {
  return {
    id: record.id,
    content: record.content,
    meta: record.meta as StoredRecord["meta"],
    tree: record.tree,
    temporal: record.temporal,
    name: record.name,
    hasEmbedding: record.hasEmbedding,
    version: record.version,
    versionHash: record.versionHash,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt?.toISOString() ?? null,
  };
}

function mapSearchResult(result: SearchResult) {
  return { ...mapStoredRecord(result), score: result.score };
}

function rpcError(
  id: RpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): object {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function issues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.map((part) =>
      typeof part === "symbol" ? part.toString() : part,
    ),
  }));
}

async function readRequestBody(
  request: Request,
  maxRequestBodyBytes: number,
): Promise<Uint8Array | undefined> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxRequestBodyBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requestTooLarge(maxRequestBodyBytes: number): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: `Request body exceeds ${maxRequestBodyBytes} bytes`,
      },
    },
    { status: 413 },
  );
}

function rpcResponse(body: object): Response {
  return Response.json(body, { status: 200 });
}
