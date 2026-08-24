/**
 * searchgres — Postgres-native hybrid search.
 *
 * Public entry point. Everything a consumer can use is re-exported here; any
 * module not reachable from this file is internal and may change without a
 * major version bump.
 */

export { LIBRARY_VERSION } from "./version.ts";
