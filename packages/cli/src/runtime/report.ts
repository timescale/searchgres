import {
  InvalidConfigError,
  InvalidInputError,
  SearchgresError,
  TreePathError,
  ValidationError,
} from "searchgres";
import { z } from "zod";

export class InputError extends Error {}

/**
 * Reduce any failure to a stable code and a message safe to print or return
 * to an MCP host.
 *
 * Validation diagnostics are retained: they are authored by core or by this
 * binary about the caller's own input and are needed to correct it. Every
 * other message is replaced by its code, because provider, driver, and
 * unexpected errors can carry remote text, connection details, or secrets.
 */
export function safeError(error: unknown): {
  code: string;
  message: string;
  issues?: readonly {
    code: string;
    path: readonly (string | number)[];
    message: string;
  }[];
} {
  if (error instanceof InputError)
    return { code: "INVALID_INPUT", message: error.message };
  if (error instanceof z.ZodError)
    return {
      code: "INVALID_INPUT",
      message: "Invalid input; check fields and values",
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
  if (error instanceof SearchgresError) {
    const retainMessage =
      error instanceof InvalidConfigError ||
      error instanceof InvalidInputError ||
      error instanceof TreePathError;
    return {
      code: error.code,
      message: retainMessage
        ? error.message
        : `Searchgres operation failed (${error.code})`,
      ...(error instanceof ValidationError && error.issues.length > 0
        ? {
            issues: error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              message: issue.message,
            })),
          }
        : {}),
    };
  }
  return {
    code: "INTERNAL",
    message:
      "Searchgres operation failed; check database connectivity and configuration",
  };
}
export function exitCode(error: unknown): number {
  const code = safeError(error).code;
  return ["INVALID_INPUT", "TREE_PATH", "BATCH_TOO_LARGE"].includes(code)
    ? 2
    : 1;
}
