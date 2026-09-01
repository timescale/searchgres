import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Load `path` into `process.env` without overwriting anything already set, so
 * an explicit environment variable always beats a file.
 *
 * Hand-rolled rather than taking a dependency, because no library covers both
 * halves of what we need and the dialects disagree on the interesting cases.
 * `dotenv` has no writer, and it reads `#` as starting a comment — which would
 * silently truncate a database password containing one. Docker Compose's
 * `env_file`, our other consumer, instead takes every character literally and
 * does *not* strip quotes. {@link writeDotenvValue} is the reconciliation:
 * emit only values all three readers agree on.
 */
export async function loadDotenv(path: string): Promise<void> {
  if (!(await Bun.file(path).exists())) return;
  const source = await readFile(path, "utf8");
  for (const [lineNumber, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    // Destructuring a possibly-absent match yields undefined for both groups,
    // so one guard covers a non-matching line and narrows both to string.
    const [, name, rawValue] = match ?? [];
    if (name === undefined || rawValue === undefined)
      throw new Error(`${path}:${lineNumber + 1}: invalid .env assignment`);
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

/**
 * Characters that make a `.env` value ambiguous across the readers that will see
 * it, with the reason each is rejected. Quoting cannot rescue them: Docker
 * Compose does not strip quotes, so `K="v"` would deliver a value with literal
 * quotes to a deployed server.
 */
function unrepresentable(value: string): string | undefined {
  if (/[\r\n]/.test(value)) return "it contains a line break";
  if (value.includes("#"))
    return 'it contains "#", which dotenv-style readers treat as the start of a comment';
  if (value !== value.trim())
    return "it has leading or trailing whitespace, which some readers strip";
  return undefined;
}

/**
 * Advice specific to the value at hand. A `#` in a connection string is almost
 * always an unencoded password character, and that URL is already invalid —
 * `new URL("postgres://u:p#w@h/db")` throws, because `#` begins a fragment.
 * Percent-encoding is both the correct URL and representable here, so say so
 * rather than sending the user to an environment variable they do not need.
 */
function remedy(name: string, value: string): string {
  if (value.includes("#") && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return (
      `If that "#" is part of a password, percent-encode it as "%23": ` +
      `a URL with a literal "#" is invalid anyway, since "#" starts a fragment. ` +
      `Otherwise set ${name} in the environment instead of the file.`
    );
  }
  return `Set ${name} in the environment instead, and leave it blank in the file.`;
}

/**
 * Render one `NAME=value` line, refusing values that would not survive the
 * round trip. Rejecting is deliberate: writing an ambiguous line would produce a
 * file that this binary reads correctly and other tooling silently misreads,
 * turning a bad password into a confusing connection error much later.
 */
export function dotenvLine(name: string, value: string): string {
  const problem = unrepresentable(value);
  if (problem !== undefined) {
    throw new Error(
      `Cannot write ${name} to a .env file: ${problem}. ${remedy(name, value)}`,
    );
  }
  return `${name}=${value}\n`;
}

/** Write a `.env.example` beside a config, and git-ignore the real `.env`. */
export async function writeDotenvExample(
  configPath: string,
  databaseUrlEnv: string,
  apiKeyEnv: string | undefined,
): Promise<void> {
  const directory = dirname(configPath);
  const example = join(directory, ".env.example");
  if (!(await Bun.file(example).exists())) {
    // Empty values, so this always round-trips; the names are the documentation.
    await Bun.write(
      example,
      dotenvLine(databaseUrlEnv, "") +
        (apiKeyEnv ? dotenvLine(apiKeyEnv, "") : ""),
    );
  }
  const gitignore = join(directory, ".gitignore");
  const current = (await Bun.file(gitignore).exists())
    ? await readFile(gitignore, "utf8")
    : "";
  if (!current.split(/\r?\n/).includes(".env")) {
    await Bun.write(
      gitignore,
      `${current}${current !== "" && !current.endsWith("\n") ? "\n" : ""}.env\n`,
    );
  }
}
