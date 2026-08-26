/**
 * The library's own version.
 *
 * Hand-maintained and mirrored from package.json, which `version.test.ts`
 * enforces. It is duplicated rather than imported because JSON import
 * attributes are still uneven across Node, Bun, and Deno, and reading the file
 * at runtime would mean shipping filesystem access in a library that otherwise
 * needs none.
 *
 * This is package metadata only. Immutable index schemas use their own format
 * marker and never derive compatibility from the library package version.
 */
export const LIBRARY_VERSION = "0.0.0";
