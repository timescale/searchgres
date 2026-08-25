import type postgres from "postgres";
import type { NormalizedIndexConfig } from "../config.ts";
import type { ExtensionInfo } from "../db/extensions.ts";

export interface MigrationContext {
  readonly schema: string;
  /** Present only while provisioning a new index; upgrades inspect the catalog. */
  readonly creation: NormalizedIndexConfig | null;
  /** Extensions selected by the caller and ensured before migrations run. */
  readonly extensions: readonly ExtensionInfo[];
}

export interface Migration {
  readonly name: string;
  /** Oldest library version that can safely read the schema after this migration. */
  readonly minLibraryVersion: string;
  readonly up: (
    tx: postgres.TransactionSql,
    context: MigrationContext,
  ) => Promise<void>;
}

export interface AppliedMigration {
  readonly name: string;
  readonly appliedByVersion: string;
  readonly minLibraryVersion: string;
  readonly appliedAt: Date;
}
