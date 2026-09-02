import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dotenvLine, loadDotenv } from "./dotenv.ts";

test("dotenvLine round-trips the values a real .env holds", async () => {
  // Written by the `sg-server config` wizard: a database URL and an API
  // key. Every character here is literal in all three readers that see the file
  // (this one, dotenv-style tooling, and Docker Compose's env_file).
  const values: Record<string, string> = {
    SG_PLAIN: "abc123",
    SG_URL: "postgres://user:secret@host:5432/db?sslmode=require",
    // The correct spelling of a password containing "#". A URL with a literal
    // "#" is invalid (it starts a fragment), so the encoded form is the only
    // valid one — and it holds no "#", so it writes cleanly.
    SG_URL_ENCODED_HASH: "postgres://user:p%23w@host:5432/db",
    SG_KEY: "sk-proj-AbC123_-xyz",
    SG_EQUALS: "a=b",
    SG_INNER_SPACE: "two words",
    SG_QUOTES: `he said "hi" and 'bye'`,
    SG_DOLLAR: "not$interpolated",
    SG_BACKSLASH: String.raw`a\b`,
    SG_EMPTY: "",
  };

  const directory = await mkdtemp(join(tmpdir(), "sg-dotenv-"));
  try {
    const path = join(directory, ".env");
    await Bun.write(
      path,
      Object.entries(values)
        .map(([name, value]) => dotenvLine(name, value))
        .join(""),
    );
    await loadDotenv(path);
    for (const [name, value] of Object.entries(values)) {
      expect(process.env[name], name).toBe(value);
    }
  } finally {
    for (const name of Object.keys(values)) delete process.env[name];
    await rm(directory, { recursive: true, force: true });
  }
});

test("dotenvLine refuses values a reader would misinterpret", () => {
  // Rejected rather than quoted: Docker Compose does not strip quotes, so
  // `K="v"` would hand a deployed server a value with literal quote characters.
  // The message must say what to do instead, because the user is mid-wizard.
  const rejected: readonly (readonly [string, RegExp])[] = [
    ["has\nnewline", /line break/],
    ["has\rcarriage", /line break/],
    ["pass#word", /start of a comment/],
    [" leading", /leading or trailing whitespace/],
    ["trailing ", /leading or trailing whitespace/],
  ];
  for (const [value, pattern] of rejected) {
    expect(() => dotenvLine("SG_X", value), JSON.stringify(value)).toThrow(
      pattern,
    );
    expect(() => dotenvLine("SG_X", value)).toThrow(
      /Set SG_X in the environment instead/,
    );
  }
});

test("a # in a connection string is advised to percent-encode", () => {
  // `new URL` rejects this outright, so the user has a malformed URL rather than
  // an unwritable one; the message should fix the URL, not route them to an
  // environment variable they do not need.
  expect(() => new URL("postgres://user:p#w@host:5432/db")).toThrow();
  expect(() => dotenvLine("SG_DB", "postgres://user:p#w@host:5432/db")).toThrow(
    /percent-encode it as "%23"/,
  );

  // A non-URL value gets the generic advice: there is nothing to re-encode.
  expect(() => dotenvLine("SG_KEY", "sk-has#hash")).toThrow(
    /Set SG_KEY in the environment instead/,
  );
  expect(() => dotenvLine("SG_KEY", "sk-has#hash")).not.toThrow(
    /percent-encode/,
  );
});

test("loadDotenv never overwrites an existing environment variable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sg-dotenv-"));
  try {
    const path = join(directory, ".env");
    await Bun.write(path, "SG_PRESET=from-file\nSG_UNSET=from-file\n");
    process.env.SG_PRESET = "from-environment";
    await loadDotenv(path);
    expect(process.env.SG_PRESET).toBe("from-environment");
    expect(process.env.SG_UNSET).toBe("from-file");
  } finally {
    delete process.env.SG_PRESET;
    delete process.env.SG_UNSET;
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadDotenv accepts comments, blanks, export, and quoted values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sg-dotenv-"));
  try {
    const path = join(directory, ".env");
    await Bun.write(
      path,
      [
        "# a comment",
        "",
        "   ",
        "SG_A=plain",
        "export SG_B=exported",
        'SG_C="double quoted"',
        "SG_D='single quoted'",
      ].join("\n"),
    );
    await loadDotenv(path);
    expect(process.env.SG_A).toBe("plain");
    expect(process.env.SG_B).toBe("exported");
    expect(process.env.SG_C).toBe("double quoted");
    expect(process.env.SG_D).toBe("single quoted");
  } finally {
    for (const name of ["SG_A", "SG_B", "SG_C", "SG_D"])
      delete process.env[name];
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadDotenv rejects a malformed line instead of skipping it", async () => {
  // Skipping would hide a typo in a variable name, and the failure would then
  // surface as a missing-credential error somewhere unrelated.
  const directory = await mkdtemp(join(tmpdir(), "sg-dotenv-"));
  try {
    const path = join(directory, ".env");
    await Bun.write(path, "SG_OK=1\nNOT AN ASSIGNMENT\n");
    await expect(loadDotenv(path)).rejects.toThrow(
      /:2: invalid \.env assignment/,
    );
  } finally {
    delete process.env.SG_OK;
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadDotenv is a no-op when the file does not exist", async () => {
  await loadDotenv(join(tmpdir(), "sg-dotenv-does-not-exist", ".env"));
});
