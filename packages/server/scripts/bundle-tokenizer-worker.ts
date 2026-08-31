import { mkdir } from "node:fs/promises";

const output = "src/tokenizer.worker.generated.cjs";
const result = await Bun.build({
  entrypoints: ["src/tokenizer.worker.ts"],
  target: "bun",
  format: "cjs",
  minify: true,
  write: false,
});

if (!result.success) {
  throw new AggregateError(result.logs, "Could not bundle tokenizer worker");
}
const bundle = result.outputs[0];
if (!bundle) {
  throw new Error("Tokenizer worker bundle produced no output");
}
await mkdir("src", { recursive: true });
await Bun.write(output, await bundle.text());
