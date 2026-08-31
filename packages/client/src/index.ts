import {
  type CopyTreeParams,
  type CountTreeParams,
  type DeleteByNameParams,
  type DeleteParams,
  type DeleteTreeParams,
  type GetByNameParams,
  type GetParams,
  type InsertManyParams,
  type InsertParams,
  type ListTreeParams,
  type MoveTreeParams,
  methods,
  type PatchParams,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  rpcFailureResponseSchema,
  rpcResponseSchema,
  rpcSuccessResponseSchema,
  type SearchParams,
  type TreeViewParams,
  type UpsertManyParams,
  type UpsertParams,
} from "@searchgres/protocol";
import { z } from "zod";

export class SearchgresRpcError extends Error {
  readonly rpcCode: number;
  readonly data: RpcError["data"];

  constructor(error: RpcError) {
    super(error.message);
    this.name = "SearchgresRpcError";
    this.rpcCode = error.code;
    this.data = error.data;
  }
}

export class SearchgresTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchgresTransportError";
  }
}

export interface RpcTransport {
  send(request: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface FetchTransportOptions {
  readonly url: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit;
}

export function createFetchTransport(
  options: FetchTransportOptions,
): RpcTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const url = String(options.url);
  return {
    async send(request, signal) {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...options.headers,
          },
          body: JSON.stringify(request),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw new SearchgresTransportError("searchgres RPC request failed", {
          cause: error,
        });
      }
      if (!response.ok) {
        throw new SearchgresTransportError(
          `searchgres RPC transport returned HTTP ${response.status}`,
        );
      }
      try {
        return await response.json();
      } catch (error) {
        throw new SearchgresTransportError(
          "searchgres RPC transport returned invalid JSON",
          { cause: error },
        );
      }
    },
  };
}

export interface SearchgresClientOptions {
  readonly transport: RpcTransport;
}

export interface SearchgresClient {
  call<M extends RpcMethod>(
    method: M,
    ...args: RpcParams<M> extends undefined
      ? [params?: RpcParams<M>, options?: { readonly signal?: AbortSignal }]
      : [params: RpcParams<M>, options?: { readonly signal?: AbortSignal }]
  ): Promise<RpcResult<M>>;
  discover(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RpcResult<"rpc.discover">>;
  info(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RpcResult<"searchgres.v1.server.info">>;
  upsert(
    params: UpsertParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.upsert">>;
  upsertMany(
    params: UpsertManyParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.upsertMany">>;
  insert(
    params: InsertParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.insert">>;
  insertMany(
    params: InsertManyParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.insertMany">>;
  get(
    params: GetParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.get">>;
  getByName(
    params: GetByNameParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.getByName">>;
  patch(
    params: PatchParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.patch">>;
  delete(
    params: DeleteParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.delete">>;
  deleteByName(
    params: DeleteByNameParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.deleteByName">>;
  moveTree(
    params: MoveTreeParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.tree.move">>;
  copyTree(
    params: CopyTreeParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.tree.copy">>;
  deleteTree(
    params: DeleteTreeParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.tree.delete">>;
  countTree(
    params: CountTreeParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.tree.count">>;
  listTree(
    params: ListTreeParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.tree.list">>;
  treeView(
    params: TreeViewParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.tree.view">>;
  search(
    params: SearchParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.search">>;
}

export function createClient(
  options: SearchgresClientOptions,
): SearchgresClient {
  let nextId = 1;

  async function call<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    callOptions?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<M>> {
    const definition = methods[method];
    const parsedParams = definition.params.safeParse(params);
    if (!parsedParams.success) {
      throw new SearchgresTransportError(
        `Invalid params for ${method}: ${z.prettifyError(parsedParams.error)}`,
        { cause: parsedParams.error },
      );
    }

    const id = String(nextId++);
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (parsedParams.data !== undefined) {
      payload.params = parsedParams.data;
    }
    const raw = await options.transport.send(payload, callOptions?.signal);
    const response = rpcResponseSchema.safeParse(raw);
    if (!response.success) {
      throw new SearchgresTransportError(
        "searchgres RPC returned an invalid envelope",
        {
          cause: response.error,
        },
      );
    }
    if (rpcFailureResponseSchema.safeParse(response.data).success) {
      const failure = rpcFailureResponseSchema.parse(response.data);
      throw new SearchgresRpcError(failure.error);
    }
    const success = rpcSuccessResponseSchema.parse(response.data);
    if (success.id !== id) {
      throw new SearchgresTransportError(
        "searchgres RPC response id did not match request",
      );
    }
    const result = definition.result.safeParse(success.result);
    if (!result.success) {
      throw new SearchgresTransportError(
        `searchgres RPC returned an invalid result for ${method}`,
        { cause: result.error },
      );
    }
    return result.data as RpcResult<M>;
  }

  return {
    call: call as SearchgresClient["call"],
    discover: (callOptions) => call("rpc.discover", undefined, callOptions),
    info: (callOptions) =>
      call("searchgres.v1.server.info", undefined, callOptions),
    upsert: (params, callOptions) =>
      call("searchgres.v1.record.upsert", params, callOptions),
    upsertMany: (params, callOptions) =>
      call("searchgres.v1.record.upsertMany", params, callOptions),
    insert: (params, callOptions) =>
      call("searchgres.v1.record.insert", params, callOptions),
    insertMany: (params, callOptions) =>
      call("searchgres.v1.record.insertMany", params, callOptions),
    get: (params, callOptions) =>
      call("searchgres.v1.record.get", params, callOptions),
    getByName: (params, callOptions) =>
      call("searchgres.v1.record.getByName", params, callOptions),
    patch: (params, callOptions) =>
      call("searchgres.v1.record.patch", params, callOptions),
    delete: (params, callOptions) =>
      call("searchgres.v1.record.delete", params, callOptions),
    deleteByName: (params, callOptions) =>
      call("searchgres.v1.record.deleteByName", params, callOptions),
    moveTree: (params, callOptions) =>
      call("searchgres.v1.tree.move", params, callOptions),
    copyTree: (params, callOptions) =>
      call("searchgres.v1.tree.copy", params, callOptions),
    deleteTree: (params, callOptions) =>
      call("searchgres.v1.tree.delete", params, callOptions),
    countTree: (params, callOptions) =>
      call("searchgres.v1.tree.count", params, callOptions),
    listTree: (params, callOptions) =>
      call("searchgres.v1.tree.list", params, callOptions),
    treeView: (params, callOptions) =>
      call("searchgres.v1.tree.view", params, callOptions),
    search: (params, callOptions) =>
      call("searchgres.v1.search", params, callOptions),
  };
}

export function createSearchgresClient(
  options: Omit<FetchTransportOptions, "fetch"> & {
    readonly fetch?: typeof globalThis.fetch;
  },
): SearchgresClient {
  return createClient({ transport: createFetchTransport(options) });
}
