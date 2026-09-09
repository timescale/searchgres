import { z } from "zod";
import type { ValidationIssue } from "./errors.ts";

/** Record metadata: a JSON object with arbitrary JSON values. */
export const metaSchema = z.record(z.string(), z.json());

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
