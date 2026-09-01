// Cross-compiles one binary for every release target. Shared by all binary
// surfaces so `sg`, `sg-server`, and `sg-mcp` ship for the same platforms and a
// target list per package cannot drift.
//
//   ../../bun ../../scripts/compile-targets.ts <name> <entrypoint>
const [name, entrypoint] = Bun.argv.slice(2);
if (name === undefined || entrypoint === undefined) {
  console.error(
    "usage: compile-targets.ts <binary-name> <entrypoint>  (run from a package)",
  );
  process.exit(1);
}

const targets = [
  { target: "bun-linux-x64", suffix: "linux-amd64" },
  { target: "bun-linux-arm64", suffix: "linux-arm64" },
  { target: "bun-windows-x64", suffix: "windows-amd64.exe" },
  { target: "bun-windows-arm64", suffix: "windows-arm64.exe" },
  { target: "bun-darwin-x64", suffix: "macos-amd64" },
  { target: "bun-darwin-arm64", suffix: "macos-arm64" },
] as const;

for (const { target, suffix } of targets) {
  const output = `dist/${name}-${suffix}`;
  console.log(`Compiling ${target} → ${output}`);
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      entrypoint,
      "--compile",
      `--target=${target}`,
      `--outfile=${output}`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
