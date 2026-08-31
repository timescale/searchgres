import assert from "node:assert/strict";
import test from "node:test";
import {
  createClient,
  type RpcTransport,
  SearchgresRpcError,
} from "./index.ts";

test("client validates and returns an upsertMany result", async () => {
  const transport: RpcTransport = {
    async send(request) {
      assert.deepEqual(request, {
        jsonrpc: "2.0",
        id: "1",
        method: "searchgres.v1.record.upsertMany",
        params: {
          records: [{ content: "hello", meta: {}, tree: "", name: null }],
          onConflict: "replace",
        },
      });
      return {
        jsonrpc: "2.0",
        id: "1",
        result: {
          results: [
            {
              id: "019ce89d-f8b4-7000-8000-000000000001",
              status: "inserted",
            },
          ],
        },
      };
    },
  };
  const client = createClient({ transport });
  const result = await client.upsertMany({ records: [{ content: "hello" }] });
  assert.equal(result.results[0]?.status, "inserted");
});

test("client maps a JSON-RPC domain failure", async () => {
  const client = createClient({
    transport: {
      async send() {
        return {
          jsonrpc: "2.0",
          id: "1",
          error: {
            code: -32001,
            message: "Record already exists",
            data: { searchgresCode: "CONFLICT", type: "ConflictError" },
          },
        };
      },
    },
  });
  await assert.rejects(
    () => client.upsertMany({ records: [{ content: "hello" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SearchgresRpcError);
      assert.equal(error.rpcCode, -32001);
      assert.equal(error.data?.searchgresCode, "CONFLICT");
      return true;
    },
  );
});
