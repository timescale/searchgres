// Repeatable warm-cache startup baseline; build first with ./bun run compile.
import { arch, platform } from "node:os";

const cases = [["--version"], ["--help"], ["--unknown-option"]];
const samples = 30;
for (const args of cases) {
  const times: number[] = [];
  for (let i = 0; i < samples + 3; i++) {
    const start = performance.now();
    const result = Bun.spawnSync(["./dist/searchgres", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (result.exitCode !== (args[0] === "--unknown-option" ? 2 : 0))
      throw new Error("Unexpected startup benchmark exit code");
    if (i >= 3) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      platform: platform(),
      arch: arch(),
      args,
      samples,
      medianMs: times[Math.floor(samples / 2)],
      p95Ms: times[Math.floor(samples * 0.95)],
    }),
  );
}
