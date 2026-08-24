// Stage the repository-root LICENSE, NOTICE, and README into a package
// directory so `npm pack` / `npm publish` include them, then remove them again
// afterwards.
//
// npm only picks these up from the package's own directory, and `files` cannot
// reference paths outside it. Symlinks do not survive `npm pack` — it drops
// them rather than following them — so the files have to be real copies at pack
// time. Keeping the originals at the repo root (rather than committing
// duplicates) means there is one source of truth and the published copies
// cannot go stale.
//
// Run from a package directory via its prepack/postpack hooks:
//   node ../../scripts/copy-package-files.mjs           stage the files
//   node ../../scripts/copy-package-files.mjs --clean   remove them again

import { copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["LICENSE", "NOTICE", "README.md"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = process.cwd();
const clean = process.argv.includes("--clean");

for (const file of FILES) {
  const destination = join(packageDir, file);
  if (clean) {
    rmSync(destination, { force: true });
  } else {
    copyFileSync(join(repoRoot, file), destination);
  }
}
