/**
 * The library's own version.
 *
 * Hand-maintained and mirrored from package.json, which `version.test.ts`
 * enforces. It is duplicated rather than imported because JSON import
 * attributes are still uneven across Node, Bun, and Deno, and reading the file
 * at runtime would mean shipping filesystem access in a library that otherwise
 * needs none.
 *
 * This is not cosmetic: every migration records the library version that
 * applied it, and the compatibility floor (see the migration runner) compares
 * against this value to decide whether the running library may operate on a
 * given index schema.
 */
export const LIBRARY_VERSION = "0.0.0";
