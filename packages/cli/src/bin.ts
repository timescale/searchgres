import { CommanderError } from "commander";
import { runProgram } from "./program.ts";
import { exitCode, safeError } from "./runtime/report.ts";

try {
  await runProgram(process.argv.slice(2));
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    console.error(JSON.stringify({ error: safeError(error) }));
    process.exitCode = exitCode(error);
  }
}
