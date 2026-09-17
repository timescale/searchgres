import {
  InvalidConfigError,
  SearchgresError,
  ValidationError,
} from "searchgres";
import { z } from "zod";

export class InputError extends Error {}
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
        message: "Invalid field value",
      })),
    };
  if (error instanceof SearchgresError) {
    // Even typed provider errors can retain remote messages. Never return their
    // raw messages or causes. Stable codes carry the operational distinction.
    return {
      code: error.code,
      message:
        error instanceof InvalidConfigError
          ? error.message
          : `Searchgres operation failed (${error.code})`,
      ...(error instanceof ValidationError
        ? {
            issues: error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              message: "Invalid field value",
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
