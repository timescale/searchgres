import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entitlements = fileURLToPath(
  new URL("./macos-entitlements.plist", import.meta.url),
);

export function signMacosBinary(binary: string): void {
  if (process.platform !== "darwin") return;
  if (!existsSync(binary)) throw new Error(`Binary does not exist: ${binary}`);

  // Bun emits an ad-hoc signature, but replacing it ensures the executable has
  // the JIT entitlements required by its JavaScript runtime.
  Bun.spawnSync({
    cmd: ["codesign", "--remove-signature", binary],
    stdout: "ignore",
    stderr: "ignore",
  });

  console.log(`Signing ${binary} with macOS JIT entitlements`);
  run([
    "codesign",
    "--force",
    "--deep",
    "--sign",
    "-",
    "--entitlements",
    entitlements,
    binary,
  ]);
  run(["codesign", "--verify", "--strict", binary]);
}

function run(cmd: readonly string[]): void {
  const result = Bun.spawnSync({
    cmd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

if (import.meta.main) {
  const binaries = Bun.argv.slice(2);
  if (binaries.length === 0) {
    console.error("usage: macos-sign.ts <binary> [binary ...]");
    process.exit(1);
  }
  for (const binary of binaries) signMacosBinary(binary);
}
