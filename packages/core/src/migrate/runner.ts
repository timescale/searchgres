import type postgres from "postgres";
import semver from "semver";
import {
  MigrationError,
  SchemaVersionError,
  SearchgresError,
} from "../errors.ts";
import { runSql } from "../sql/exec.ts";
import { LIBRARY_VERSION } from "../version.ts";
import type { AppliedMigration, Migration, MigrationContext } from "./types.ts";

interface MigrationRow {
  readonly name: string;
  readonly applied_by_version: string;
  readonly min_library_version: string;
  readonly applied_at: Date;
}

export interface RunMigrationsOptions {
  readonly schema: string;
  readonly migrations: readonly Migration[];
  readonly context: Omit<MigrationContext, "schema">;
  /** Injectable for migration compatibility tests; defaults to this package version. */
  readonly libraryVersion?: string;
}

export interface RunMigrationsResult {
  readonly applied: readonly string[];
  readonly minimumLibraryVersion: string | null;
}

/** Read the tracked migration ledger from an already-bootstrapped index schema. */
export async function readAppliedMigrations(
  tx: postgres.TransactionSql,
  schema: string,
): Promise<readonly AppliedMigration[]> {
  const rows = await runSql(
    tx<MigrationRow[]>`
      select name, applied_by_version, min_library_version, applied_at
      from ${tx(schema)}.migration
      order by name
    `,
    {
      spanName: "readAppliedMigrations",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        name: row.name,
        appliedByVersion: row.applied_by_version,
        minLibraryVersion: row.min_library_version,
        appliedAt: row.applied_at,
      }),
    ),
  );
}

/** Apply every known migration absent from the ledger using the caller's transaction. */
export async function runMigrations(
  tx: postgres.TransactionSql,
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const libraryVersion = options.libraryVersion ?? LIBRARY_VERSION;
  const migrations = sortedMigrations(options.migrations);
  const applied = await readAppliedMigrations(tx, options.schema);
  const minimumLibraryVersion = compatibilityFloor(applied);
  ensureCompatible(options.schema, libraryVersion, minimumLibraryVersion);

  const appliedNames = new Set(applied.map((migration) => migration.name));
  const newlyApplied: string[] = [];
  const context: MigrationContext = {
    schema: options.schema,
    ...options.context,
  };

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) {
      continue;
    }
    ensureCompatible(
      options.schema,
      libraryVersion,
      migration.minLibraryVersion,
    );

    try {
      await migration.up(tx, context);
      await recordMigration(tx, options.schema, migration, libraryVersion);
    } catch (error) {
      if (error instanceof SearchgresError) {
        throw error;
      }
      throw new MigrationError(migration.name, { cause: error });
    }
    newlyApplied.push(migration.name);
  }

  const resultingFloor = compatibilityFloor([
    ...applied,
    ...migrations
      .filter((migration) => newlyApplied.includes(migration.name))
      .map((migration) => ({
        name: migration.name,
        appliedByVersion: libraryVersion,
        minLibraryVersion: migration.minLibraryVersion,
        appliedAt: new Date(0),
      })),
  ]);
  return Object.freeze({
    applied: Object.freeze(newlyApplied),
    minimumLibraryVersion: resultingFloor,
  });
}

async function recordMigration(
  tx: postgres.TransactionSql,
  schema: string,
  migration: Migration,
  libraryVersion: string,
): Promise<void> {
  await runSql(
    tx`
      insert into ${tx(schema)}.migration
        (name, applied_by_version, min_library_version)
      values
        (${migration.name}, ${libraryVersion}, ${migration.minLibraryVersion})
    `,
    {
      spanName: "recordAppliedMigration",
      dbOperationName: "INSERT",
      namespace: schema,
    },
  );
}

function sortedMigrations(
  migrations: readonly Migration[],
): readonly Migration[] {
  const names = new Set<string>();
  for (const migration of migrations) {
    if (names.has(migration.name)) {
      throw new MigrationError(migration.name, {
        cause: new Error(
          `Duplicate migration name ${JSON.stringify(migration.name)}`,
        ),
      });
    }
    names.add(migration.name);
  }
  return [...migrations].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function compatibilityFloor(
  migrations: readonly Pick<AppliedMigration, "minLibraryVersion">[],
): string | null {
  let floor: string | null = null;
  for (const migration of migrations) {
    parseVersion(migration.minLibraryVersion, "migration compatibility floor");
    if (floor === null || semver.gt(migration.minLibraryVersion, floor)) {
      floor = migration.minLibraryVersion;
    }
  }
  return floor;
}

function ensureCompatible(
  schema: string,
  libraryVersion: string,
  minimumLibraryVersion: string | null,
): void {
  parseVersion(libraryVersion, "library version");
  if (minimumLibraryVersion === null) {
    return;
  }
  parseVersion(minimumLibraryVersion, "migration compatibility floor");
  if (semver.lt(libraryVersion, minimumLibraryVersion)) {
    throw new SchemaVersionError(schema, libraryVersion, minimumLibraryVersion);
  }
}

function parseVersion(version: string, label: string): void {
  if (semver.valid(version) === null) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(version)}`);
  }
}
