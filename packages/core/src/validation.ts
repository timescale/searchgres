import type { z } from "zod";
import type { ValidationIssue } from "./errors.ts";

/** Map a Zod issue to the validator-neutral shape carried on typed errors. */
export function toValidationIssue(issue: z.core.$ZodIssue): ValidationIssue {
  return {
    code: issue.code,
    message: issue.message,
    path: issue.path.map((component) =>
      typeof component === "symbol" ? component.toString() : component,
    ),
  };
}
