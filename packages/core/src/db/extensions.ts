import type postgres from "postgres";
import semver from "semver";
import { ExtensionError } from "../errors.ts";
import { postgresErrorCode } from "../sql/errors.ts";
import { runSql } from "../sql/exec.ts";

export interface ExtensionRequirement {
  readonly name: string;
  readonly minimumVersion: string;
}

export interface ExtensionInfo {
  readonly name: string;
  readonly version: string;
}

interface ExtensionStatusRow {
  readonly extversion: string | null;
  readonly nspname: string | null;
  readonly default_version: string | null;
}

/**
 * Ensure one required extension is installed in `public` and version-compatible,
 * creating it in `public` when absent. searchgres is public-only: an extension
 * installed in another schema is rejected rather than moved. The caller owns the
 * surrounding transaction and any advisory lock.
 */
export async function ensureExtension(
  tx: postgres.TransactionSql,
  requirement: ExtensionRequirement,
): Promise<ExtensionInfo> {
  const status = await extensionStatus(tx, requirement.name);
  if (status.extversion !== null) {
    return toExtensionInfo(status, requirement);
  }

  if (
    status.default_version === null ||
    !versionAtLeast(status.default_version, requirement.minimumVersion)
  ) {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "unavailable",
      { foundVersion: status.default_version },
    );
  }

  try {
    await runSql(
      tx`create extension if not exists ${tx(requirement.name)} with schema public`,
      { spanName: "createExtension", dbOperationName: "CREATE" },
    );
  } catch (error) {
    if (postgresErrorCode(error) === "42501") {
      throw new ExtensionError(
        requirement.name,
        requirement.minimumVersion,
        "permission_denied",
        { cause: error },
      );
    }
    throw error;
  }

  return toExtensionInfo(
    await extensionStatus(tx, requirement.name),
    requirement,
  );
}

/** Read one installed extension without creating or otherwise mutating it. */
export async function getExtensionInfo(
  sql: postgres.ISql,
  requirement: ExtensionRequirement,
): Promise<ExtensionInfo> {
  return toExtensionInfo(
    await extensionStatus(sql, requirement.name),
    requirement,
  );
}

async function extensionStatus(
  tx: postgres.ISql,
  name: string,
): Promise<ExtensionStatusRow> {
  const [status] = await runSql(
    tx<ExtensionStatusRow[]>`
      -- Preserve one status row even when this extension is neither installed
      -- nor available, so the caller receives a typed unavailable error.
      select
        installed.extversion
      , n.nspname
      , available.default_version
      from (select 1) as singleton
      left outer join pg_catalog.pg_extension installed
        on (installed.extname = ${name})
      left outer join pg_catalog.pg_namespace n
        on (n.oid = installed.extnamespace)
      left outer join pg_catalog.pg_available_extensions available
        on (available.name = ${name})
    `,
    { spanName: "checkExtension", dbOperationName: "SELECT" },
  );
  return (
    status ?? {
      extversion: null,
      nspname: null,
      default_version: null,
    }
  );
}

function toExtensionInfo(
  status: ExtensionStatusRow,
  requirement: ExtensionRequirement,
): ExtensionInfo {
  if (status.extversion === null || status.nspname === null) {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "missing",
    );
  }
  if (status.nspname !== "public") {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "wrong_schema",
      { foundVersion: status.extversion },
    );
  }
  if (!versionAtLeast(status.extversion, requirement.minimumVersion)) {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "too_old",
      { foundVersion: status.extversion },
    );
  }
  return Object.freeze({
    name: requirement.name,
    version: status.extversion,
  });
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualVersion = semver.coerce(actual);
  const minimumVersion = semver.coerce(minimum);
  return (
    actualVersion !== null &&
    minimumVersion !== null &&
    actualVersion.compare(minimumVersion) >= 0
  );
}
