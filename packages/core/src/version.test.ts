import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LIBRARY_VERSION } from "./version.ts";

test("LIBRARY_VERSION matches the package.json version", () => {
  // The constant is duplicated from package.json on purpose (see version.ts).
  // This test is what keeps the duplicate honest.
  const packageJsonPath = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    "package.json",
  );
  const packageJson: unknown = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  );

  assert.ok(
    typeof packageJson === "object" && packageJson !== null,
    "package.json should parse to an object",
  );
  const { version } = packageJson as { version?: unknown };

  assert.equal(
    version,
    LIBRARY_VERSION,
    "LIBRARY_VERSION and package.json#version have drifted; update both.",
  );
});
