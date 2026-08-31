// Runs a command against a throwaway Postgres container, then removes it.
//
// pg_textsearch has to be in shared_preload_libraries, so the integration
// suites need our image rather than a stock one. This script exists so the
// build/start/wait/teardown sequence is defined exactly once and shared by
// local runs (`check:full`) and CI, instead of being duplicated as inline
// workflow shell that can silently drift from what developers run.
//
//   ./bun scripts/with-postgres.ts ./bun run test:db
const command = Bun.argv.slice(2);
if (command.length === 0) {
  console.error("usage: ./bun scripts/with-postgres.ts <command> [args...]");
  process.exit(1);
}

const container = "searchgres-postgres";
const image = "searchgres-postgres";
const root = `${import.meta.dir}/..`;

function spawn(cmd: readonly string[], quiet = false): number {
  const { exitCode } = Bun.spawnSync({
    cmd: [...cmd],
    cwd: root,
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return exitCode;
}

function must(cmd: readonly string[]): void {
  const exitCode = spawn(cmd);
  if (exitCode !== 0) process.exit(exitCode);
}

function remove(): void {
  spawn(["docker", "rm", "-f", container], true);
}

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // pg_isready inside the container: no host psql client needed, so a laptop
    // and a CI runner behave the same.
    const ready = spawn(
      [
        "docker",
        "exec",
        container,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      true,
    );
    if (ready === 0) return;
    await Bun.sleep(500);
  }
  spawn(["docker", "logs", container]);
  console.error("with-postgres: postgres did not become ready");
  process.exit(1);
}

must(["./bun", "run", "pg:build"]);
remove();
must([
  "docker",
  "run",
  "-d",
  "--name",
  container,
  "-e",
  "POSTGRES_HOST_AUTH_METHOD=trust",
  "-p",
  "127.0.0.1:5432:5432",
  image,
]);
// Capture the status first, then tear down, then exit: calling process.exit()
// inside the try would skip the finally block and leak the container.
let status: number;
try {
  await waitForReady();
  status = spawn(command);
} finally {
  remove();
}
process.exit(status);
