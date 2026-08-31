import { z } from "zod";

export const API_VERSION = "v1" as const;
export const SEARCHGRES_FAILURE_CODE = -32001;

export const uuidSchema = z.uuidv7();
export const timestampSchema = z.iso.datetime({ offset: true });
export const jsonObjectSchema = z.record(z.string(), z.json());

const treePathSchema = z
  .string()
  .refine(
    (path) =>
      path === "" ||
      path.split(".").every((label) => /^[A-Za-z0-9_-]+$/.test(label)),
    "expected dot-separated ltree labels matching [A-Za-z0-9_-]+ (or an empty string for the root)",
  );
const nonEmptyStringSchema = z.string().min(1);
const temporalTupleSchema = z
  .union([
    z.tuple([timestampSchema]),
    z.tuple([timestampSchema, timestampSchema]),
  ])
  .superRefine((value, context) => {
    if (value.length === 2 && Date.parse(value[0]) >= Date.parse(value[1])) {
      context.addIssue({
        code: "custom",
        message: "interval start must be before its end",
      });
    }
  });

export const recordInputSchema = z
  .strictObject({
    id: uuidSchema.optional(),
    content: z.string(),
    meta: jsonObjectSchema.default({}),
    tree: treePathSchema.default(""),
    temporal: temporalTupleSchema.optional(),
    name: z.string().nullable().default(null),
  })
  .describe("A record to write. Server clients cannot supply an embedding.");

export const storedRecordSchema = z.strictObject({
  id: uuidSchema,
  content: z.string(),
  meta: jsonObjectSchema,
  tree: z.string(),
  temporal: z.string().nullable(),
  name: z.string().nullable(),
  hasEmbedding: z.boolean(),
  version: z.string(),
  versionHash: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema.nullable(),
});

export const searchResultSchema = storedRecordSchema.extend({
  score: z.number().finite(),
});

export const upsertResultSchema = z.strictObject({
  id: uuidSchema,
  status: z.enum(["inserted", "updated", "skipped"]),
});

type FilterNode =
  | { readonly and: readonly FilterNode[] }
  | { readonly or: readonly FilterNode[] }
  | { readonly not: FilterNode }
  | { readonly tree: string }
  | { readonly lquery: string }
  | { readonly ltxtquery: string }
  | { readonly meta: Record<string, unknown> }
  | { readonly metaPredicate: string }
  | { readonly temporalWithin: readonly [string, string] }
  | { readonly temporalOverlaps: readonly [string, string] }
  | { readonly temporalBefore: string }
  | { readonly temporalAfter: string }
  | { readonly temporalContains: string }
  | { readonly regexp: string };

const rangeSchema = z.tuple([timestampSchema, timestampSchema]);
const nonEmptyMetaSchema = jsonObjectSchema.refine(
  (meta) => Object.keys(meta).length > 0,
  "meta filter must not be an empty object",
);

export const filterSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(filterSchema).min(2) }),
    z.strictObject({ or: z.array(filterSchema).min(2) }),
    z.strictObject({ not: filterSchema }),
    z.strictObject({ tree: treePathSchema }),
    z.strictObject({ lquery: nonEmptyStringSchema }),
    z.strictObject({ ltxtquery: nonEmptyStringSchema }),
    z.strictObject({ meta: nonEmptyMetaSchema }),
    z.strictObject({ metaPredicate: nonEmptyStringSchema }),
    z.strictObject({ temporalWithin: rangeSchema }),
    z.strictObject({ temporalOverlaps: rangeSchema }),
    z.strictObject({ temporalBefore: timestampSchema }),
    z.strictObject({ temporalAfter: timestampSchema }),
    z.strictObject({ temporalContains: timestampSchema }),
    z.strictObject({ regexp: nonEmptyStringSchema }),
  ]),
);

const onConflictSchema = z.enum(["error", "ignore", "replace"]);
const recordArraySchema = z.array(recordInputSchema).min(1).max(1000);

export const upsertParamsSchema = z.strictObject({
  record: recordInputSchema,
  onConflict: onConflictSchema.default("replace"),
});
export const upsertResultEnvelopeSchema = z.strictObject({
  result: upsertResultSchema,
});
export const upsertManyParamsSchema = z.strictObject({
  records: recordArraySchema,
  onConflict: onConflictSchema.default("replace"),
});
export const upsertManyResultSchema = z.strictObject({
  results: z.array(upsertResultSchema),
});
export const insertParamsSchema = z.strictObject({ record: recordInputSchema });
export const insertManyParamsSchema = z.strictObject({
  records: recordArraySchema,
});
export const getParamsSchema = z.strictObject({ id: uuidSchema });
export const getByNameParamsSchema = z.strictObject({
  tree: treePathSchema,
  name: z.string().min(1),
});
export const storedRecordEnvelopeSchema = z.strictObject({
  record: storedRecordSchema,
});
const patchInputSchema = z
  .strictObject({
    content: z.string().optional(),
    meta: jsonObjectSchema.optional(),
    tree: treePathSchema.optional(),
    name: z.string().nullable().optional(),
    temporal: temporalTupleSchema.nullable().optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "patch must set at least one field",
  );
export const patchParamsSchema = z.strictObject({
  id: uuidSchema,
  priorVersionHash: z.string().min(1),
  patch: patchInputSchema,
});
export const deleteParamsSchema = z.strictObject({ id: uuidSchema });
export const deleteByNameParamsSchema = getByNameParamsSchema;
export const emptyResultSchema = z.strictObject({});

const treeMutationOptionsSchema = z.strictObject({
  dryRun: z.boolean().optional(),
});
const treeMutationResultSchema = z.strictObject({
  count: z.number().int().nonnegative(),
});
export const moveTreeParamsSchema = z.strictObject({
  source: treePathSchema,
  destination: treePathSchema,
  options: treeMutationOptionsSchema.optional(),
});
export const copyTreeParamsSchema = moveTreeParamsSchema;
export const deleteTreeParamsSchema = z.strictObject({
  tree: treePathSchema,
  options: treeMutationOptionsSchema.optional(),
});
const treeCountSelectorSchema = z.union([
  z.strictObject({ tree: treePathSchema }),
  z.strictObject({ lquery: nonEmptyStringSchema }),
  z.strictObject({ ltxtquery: nonEmptyStringSchema }),
]);
export const countTreeParamsSchema = z.strictObject({
  selector: treeCountSelectorSchema,
  limit: z.number().int().min(1).optional(),
});
export const treeCountResultSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  capped: z.boolean(),
});
export const listTreeParamsSchema = z.strictObject({
  lquery: nonEmptyStringSchema,
});
export const listTreeResultSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      tree: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export const treeViewParamsSchema = z.strictObject({
  tree: treePathSchema.optional(),
  levels: z.number().int().nonnegative().optional(),
});
export const treeViewResultSchema = listTreeResultSchema;

export const searchParamsSchema = z
  .strictObject({
    semantic: nonEmptyStringSchema.optional(),
    fulltext: nonEmptyStringSchema.optional(),
    filter: filterSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    candidateLimit: z.number().int().min(1).max(1000).optional(),
    semanticThreshold: z.number().min(0).max(1).optional(),
    k: z.number().min(0).optional(),
    fulltextWeight: z.number().min(0).max(1).optional(),
    semanticWeight: z.number().min(0).max(1).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    after: uuidSchema.optional(),
    before: uuidSchema.optional(),
  })
  .superRefine((options, context) => {
    const semantic = options.semantic !== undefined;
    const fulltext = options.fulltext !== undefined;
    const ranked = semantic || fulltext;
    const hybrid = semantic && fulltext;

    if (options.semanticThreshold !== undefined && !semantic) {
      context.addIssue({
        code: "custom",
        path: ["semanticThreshold"],
        message: "semanticThreshold requires a semantic arm",
      });
    }
    for (const key of [
      "candidateLimit",
      "k",
      "fulltextWeight",
      "semanticWeight",
    ] as const) {
      if (options[key] !== undefined && !hybrid) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} only applies to a hybrid search`,
        });
      }
    }
    for (const key of ["order", "after", "before"] as const) {
      if (options[key] !== undefined && ranked) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} only applies to a filter-only search`,
        });
      }
    }
    if (options.after !== undefined && options.before !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["before"],
        message: "provide either after or before, not both",
      });
    }
  });
export const searchResultEnvelopeSchema = z.strictObject({
  results: z.array(searchResultSchema),
});

export const serverInfoResultSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  serverVersion: z.string(),
  capabilities: z.strictObject({
    semanticText: z.literal(true),
    fulltext: z.literal(true),
    userSuppliedVectors: z.literal(false),
    workerManagedByServer: z.literal(true),
    readOnly: z.boolean(),
  }),
});

export const openRpcDocumentSchema = z.looseObject({
  openrpc: z.string(),
  info: z.object({ title: z.string(), version: z.string() }),
  methods: z.array(z.unknown()),
});

function method<P extends z.ZodType, R extends z.ZodType>(
  summary: string,
  params: P,
  result: R,
) {
  return { summary, params, result };
}

export const methods = {
  "rpc.discover": method(
    "Return the generated OpenRPC API description.",
    z.undefined(),
    openRpcDocumentSchema,
  ),
  "searchgres.v1.server.info": method(
    "Return server API compatibility and capabilities without secrets.",
    z.undefined(),
    serverInfoResultSchema,
  ),
  "searchgres.v1.record.upsert": method(
    "Insert or replace one record. Embeddings are server-managed.",
    upsertParamsSchema,
    upsertResultEnvelopeSchema,
  ),
  "searchgres.v1.record.upsertMany": method(
    "Insert or replace up to 1,000 records. Embeddings are server-managed.",
    upsertManyParamsSchema,
    upsertManyResultSchema,
  ),
  "searchgres.v1.record.insert": method(
    "Insert one record and fail on a conflict.",
    insertParamsSchema,
    upsertResultEnvelopeSchema,
  ),
  "searchgres.v1.record.insertMany": method(
    "Insert up to 1,000 records atomically and fail on any conflict.",
    insertManyParamsSchema,
    upsertManyResultSchema,
  ),
  "searchgres.v1.record.get": method(
    "Get one record by UUIDv7 id.",
    getParamsSchema,
    storedRecordEnvelopeSchema,
  ),
  "searchgres.v1.record.getByName": method(
    "Get one record by its explicit tree and name.",
    getByNameParamsSchema,
    storedRecordEnvelopeSchema,
  ),
  "searchgres.v1.record.patch": method(
    "Optimistically patch one record without accepting an embedding.",
    patchParamsSchema,
    storedRecordEnvelopeSchema,
  ),
  "searchgres.v1.record.delete": method(
    "Delete one record by UUIDv7 id.",
    deleteParamsSchema,
    emptyResultSchema,
  ),
  "searchgres.v1.record.deleteByName": method(
    "Delete one record by its explicit tree and name.",
    deleteByNameParamsSchema,
    emptyResultSchema,
  ),
  "searchgres.v1.tree.move": method(
    "Move an inclusive tree subtree to a destination path.",
    moveTreeParamsSchema,
    treeMutationResultSchema,
  ),
  "searchgres.v1.tree.copy": method(
    "Copy an inclusive tree subtree to a destination path with fresh record ids.",
    copyTreeParamsSchema,
    treeMutationResultSchema,
  ),
  "searchgres.v1.tree.delete": method(
    "Delete an inclusive tree subtree.",
    deleteTreeParamsSchema,
    treeMutationResultSchema,
  ),
  "searchgres.v1.tree.count": method(
    "Count records selected by one explicit tree filter kind.",
    countTreeParamsSchema,
    treeCountResultSchema,
  ),
  "searchgres.v1.tree.list": method(
    "List tree nodes matching an lquery with descendant counts.",
    listTreeParamsSchema,
    listTreeResultSchema,
  ),
  "searchgres.v1.tree.view": method(
    "List an inclusive display tree rooted at a path with descendant counts.",
    treeViewParamsSchema,
    treeViewResultSchema,
  ),
  "searchgres.v1.search": method(
    "Run a filter-only, full-text, semantic-text, or hybrid search.",
    searchParamsSchema,
    searchResultEnvelopeSchema,
  ),
} as const;

/** Generate the OpenRPC document from the runtime method registry. */
export function createOpenRpcDocument() {
  return {
    openrpc: "1.3.2",
    info: {
      title: "searchgres RPC API",
      version: API_VERSION,
      license: { name: "Apache-2.0" },
    },
    methods: Object.entries(methods).map(([name, definition]) => ({
      name,
      summary: definition.summary,
      ...(definition.params instanceof z.ZodUndefined
        ? {}
        : {
            params: [
              {
                name: "params",
                required: true,
                schema: jsonSchema(definition.params),
              },
            ],
          }),
      result: {
        name: "result",
        schema: jsonSchema(definition.result),
      },
    })),
  };
}

function jsonSchema(schema: z.ZodType): object {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(schema, {
    unrepresentable: "any",
  });
  return jsonSchema;
}

export type RpcMethod = keyof typeof methods;
export type RpcParams<M extends RpcMethod> = z.input<
  (typeof methods)[M]["params"]
>;
export type RpcResult<M extends RpcMethod> = z.output<
  (typeof methods)[M]["result"]
>;

export const rpcIdSchema = z.union([z.string(), z.number()]);
export const rpcRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});

export const validationIssueSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
});
export const rpcErrorDataSchema = z
  .strictObject({
    searchgresCode: z.string().optional(),
    type: z.string().optional(),
    issues: z.array(validationIssueSchema).optional(),
  })
  .optional();
export const rpcErrorSchema = z.strictObject({
  code: z.number().int(),
  message: z.string(),
  data: rpcErrorDataSchema,
});
export const rpcSuccessResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema,
  result: z.unknown(),
});
export const rpcFailureResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema.nullable(),
  error: rpcErrorSchema,
});
export const rpcResponseSchema = z.union([
  rpcSuccessResponseSchema,
  rpcFailureResponseSchema,
]);

export type RecordInput = z.input<typeof recordInputSchema>;
export type StoredRecord = z.output<typeof storedRecordSchema>;
export type SearchResult = z.output<typeof searchResultSchema>;
export type UpsertResult = z.output<typeof upsertResultSchema>;
export type Filter = z.input<typeof filterSchema>;
export type SearchParams = z.input<typeof searchParamsSchema>;
export type UpsertParams = z.input<typeof upsertParamsSchema>;
export type UpsertManyParams = z.input<typeof upsertManyParamsSchema>;
export type InsertParams = z.input<typeof insertParamsSchema>;
export type InsertManyParams = z.input<typeof insertManyParamsSchema>;
export type GetParams = z.input<typeof getParamsSchema>;
export type GetByNameParams = z.input<typeof getByNameParamsSchema>;
export type PatchParams = z.input<typeof patchParamsSchema>;
export type DeleteParams = z.input<typeof deleteParamsSchema>;
export type DeleteByNameParams = z.input<typeof deleteByNameParamsSchema>;
export type MoveTreeParams = z.input<typeof moveTreeParamsSchema>;
export type CopyTreeParams = z.input<typeof copyTreeParamsSchema>;
export type DeleteTreeParams = z.input<typeof deleteTreeParamsSchema>;
export type CountTreeParams = z.input<typeof countTreeParamsSchema>;
export type ListTreeParams = z.input<typeof listTreeParamsSchema>;
export type TreeViewParams = z.input<typeof treeViewParamsSchema>;
export type RpcError = z.output<typeof rpcErrorSchema>;
