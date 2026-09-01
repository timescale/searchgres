import { runProgram } from "./program.ts";

try {
  await runProgram(process.argv.slice(2));
} catch (error) {
  // A user error is a message, not a stack trace: unhandled, Bun prints the
  // throw site from inside the compiled bundle, which buries it. Commander's
  // own exits (help, parse errors) already carry a code and their own output.
  if (error instanceof Error && "exitCode" in error) {
    const { exitCode } = error as { readonly exitCode: unknown };
    process.exit(typeof exitCode === "number" ? exitCode : 1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
