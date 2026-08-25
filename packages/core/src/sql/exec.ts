import { SpanStatusCode, trace } from "@opentelemetry/api";
import { LIBRARY_VERSION } from "../version.ts";
import { mapSqlError } from "./errors.ts";

const tracer = trace.getTracer("searchgres/sql", LIBRARY_VERSION);

export interface SqlOperation {
  /** Stable, low-cardinality logical action, such as `ensurePostgresVersion`. */
  readonly spanName: string;
  /** PostgreSQL verb, such as `SELECT` or `CREATE`. */
  readonly dbOperationName: string;
  /** Index schema owning the queried object, when there is one. */
  readonly namespace?: string;
}

interface QueryResult {
  readonly length?: number;
  readonly statement?: { readonly string?: string };
}

interface QueryError {
  readonly query?: unknown;
}

/**
 * Await a postgres.js query inside an always-on SQL span. Parameter values stay
 * off spans; postgres.js keeps them separately on the error object.
 */
export async function runSql<T extends QueryResult>(
  query: Promise<T>,
  operation: SqlOperation,
): Promise<T> {
  return tracer.startActiveSpan(
    operation.spanName,
    {
      attributes: {
        "db.system": "postgresql",
        "db.namespace": operation.namespace ?? "",
        "db.operation.name": operation.dbOperationName,
        "searchgres.sql": true,
      },
    },
    async (span) => {
      try {
        const result = await query;
        span.setAttribute("db.query.text", result.statement?.string ?? "");
        span.setAttribute("db.response.returned_rows", result.length ?? 0);
        return result;
      } catch (error) {
        const queryText = readErrorQuery(error);
        span.setAttribute("db.query.text", queryText);
        span.recordException(toError(error));

        const mapped = mapSqlError(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage(mapped),
        });
        throw mapped;
      } finally {
        span.end();
      }
    },
  );
}

function readErrorQuery(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const query = (error as QueryError).query;
  return typeof query === "string" ? query : "";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
