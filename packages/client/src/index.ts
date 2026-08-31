import {
  methods,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  rpcFailureResponseSchema,
  rpcResponseSchema,
  rpcSuccessResponseSchema,
  type SearchParams,
  type UpsertManyParams,
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
  upsertMany(
    params: UpsertManyParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RpcResult<"searchgres.v1.record.upsertMany">>;
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
    upsertMany: (params, callOptions) =>
      call("searchgres.v1.record.upsertMany", params, callOptions),
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
