import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  InvalidConfigError,
  InvalidInputError,
  RateLimitError,
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
