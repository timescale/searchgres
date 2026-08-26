/**
 * searchgres — Postgres-native hybrid search.
 *
 * Public entry point. Everything a consumer can use is re-exported here; any
 * module not reachable from this file is internal and may change without a
 * major version bump.
 */

export * from "./config.ts";
export * from "./create-index.ts";
export * from "./errors.ts";
export * from "./identifiers.ts";
export * from "./open-index.ts";
export { LIBRARY_VERSION } from "./version.ts";
export type { UpsertOptions, UpsertRecord, UpsertResult } from "./write.ts";
