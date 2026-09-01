import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Load `path` into `process.env` without overwriting anything already set, so
 * an explicit environment variable always beats a file. Kept dependency-free:
 * both binaries use it, and `sg` pays for everything this module imports.
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

/** Write a `.env.example` beside a config, and git-ignore the real `.env`. */
export async function writeDotenvExample(
  configPath: string,
  databaseUrlEnv: string,
  apiKeyEnv: string | undefined,
): Promise<void> {
  const directory = dirname(configPath);
  const example = join(directory, ".env.example");
  if (!(await Bun.file(example).exists())) {
    await Bun.write(
      example,
      `${databaseUrlEnv}=\n${apiKeyEnv ? `${apiKeyEnv}=\n` : ""}`,
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
