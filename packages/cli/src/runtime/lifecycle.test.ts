import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ConflictError,
  InvalidConfigError,
  InvalidInputError,
  NotFoundError,
  RateLimitError,
  StaleVersionError,
} from "searchgres";
import { z } from "zod";
import { installShutdown } from "./index.ts";
import { exitCode, InputError, safeError } from "./report.ts";

test("shutdown is idempotent and signals share the close promise", async () => {
  let calls = 0;
  let closingCalls = 0;
  let resolveClose: () => void = () => {};
  const life = installShutdown(
    () => {
      calls++;
      return new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
    },
    () => {
      closingCalls++;
    },
  );
  const first = life.stop();
  expect(life.stop()).toBe(first);
  expect(calls).toBe(1);
  expect(closingCalls).toBe(1);
  resolveClose();
  await first;
  life.dispose();
});

test("expired shutdown grace forces a child exit without claiming rollback", async () => {
  const entry = resolve(import.meta.dir, "index.ts");
  const script = `import { installShutdown } from ${JSON.stringify(entry)}; await installShutdown(() => new Promise(() => {}), () => {}, 20).stop();`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toContain("unfinished operations may have completed");
});

test("CLI exit codes and safe errors never expose provider/SQL secrets", () => {
  expect(exitCode(new InputError("bad flags"))).toBe(2);
  expect(exitCode(new InvalidInputError("bad input"))).toBe(2);
  expect(
    exitCode(new InvalidConfigError("Missing environment variable KEY")),
  ).toBe(1);
  expect(
    safeError(new InvalidConfigError("Missing environment variable KEY"))
      .message,
  ).toContain("KEY");
  // Record-state mismatches are deterministic consequences of the request:
  // exit 2 and keep core's message, which names only caller-supplied targets.
  const stale = new StaleVersionError("01900000-0000-7000-8000-000000000001");
  expect(exitCode(stale)).toBe(2);
  expect(safeError(stale).message).toBe(stale.message);
  expect(exitCode(new NotFoundError("docs.a/x"))).toBe(2);
  expect(exitCode(new ConflictError("occupied"))).toBe(2);
  for (const error of [
    new RateLimitError("secret-key"),
    new Error("postgres://user:secret@host/db"),
  ]) {
    expect(exitCode(error)).toBe(1);
    expect(JSON.stringify(safeError(error))).not.toContain("secret");
  }
  const bad = z
    .strictObject({ token: z.number() })
    .safeParse({ token: "secret" });
  if (!bad.success)
    expect(JSON.stringify(safeError(bad.error))).not.toContain("secret");
});
