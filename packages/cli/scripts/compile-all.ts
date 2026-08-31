// Cross-compiles `sg` for every release target. The tokenizer worker bundle is
// a prerequisite; the root `compile:all` script bundles it before calling here.
const targets = [
  { target: "bun-linux-x64", output: "dist/sg-linux-amd64" },
  { target: "bun-linux-arm64", output: "dist/sg-linux-arm64" },
  { target: "bun-windows-x64", output: "dist/sg-windows-amd64.exe" },
  { target: "bun-windows-arm64", output: "dist/sg-windows-arm64.exe" },
  { target: "bun-darwin-x64", output: "dist/sg-macos-amd64" },
  { target: "bun-darwin-arm64", output: "dist/sg-macos-arm64" },
] as const;

for (const { target, output } of targets) {
  console.log(`Compiling ${target} → ${output}`);
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      "./src/bin.ts",
      "--compile",
      `--target=${target}`,
      `--outfile=${output}`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
