import { runProgram } from "./program.ts";

try {
  await runProgram(process.argv.slice(2));
} catch (error) {
  if (error instanceof Error && "exitCode" in error) {
    const { exitCode } = error as { readonly exitCode: unknown };
    process.exit(typeof exitCode === "number" ? exitCode : 1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
