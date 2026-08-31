import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

const outputDirectory = `/tmp/searchgres-tokenizer-smoke-${process.pid}`;
const executable = `${outputDirectory}/tokenizer.compiled-smoke`;

afterEach(async () => {
  await rm(outputDirectory, { force: true, recursive: true });
});

test("compiled Bun binary runs the embedded Nomic tokenizer worker", async () => {
  const build = await Bun.build({
    entrypoints: ["src/tokenizer.compiled-smoke.ts"],
    compile: true,
    target: "bun",
    outdir: outputDirectory,
  });
  expect(build.success).toBe(true);

  const process = Bun.spawn({
    cmd: [executable],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).toBe(0);
  expect((await new Response(process.stdout).text()).trim()).toBe(
    "hello world",
  );
  expect(await new Response(process.stderr).text()).toBe("");
});
