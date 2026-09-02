// Flag plumbing for `searchgres`.
//
// This module must stay dependency-free. `bun build --compile` initializes a
// binary's entire module graph at startup, executed or not, so anything
// reachable from `searchgres`'s entry point is paid by every invocation. A Biome rule
// (see biome.json) enforces the important half of that: no postgres, core
// library, server, or prompt library anywhere under packages/cli/src.
//
// `searchgres-server` deliberately does not import this. The two binaries share no code:
// a handful of one-line validators is not worth a dependency edge between the
// unprivileged client and the privileged provisioning tool.

/** A parsed command line: kebab-case flag name to value, or `true` if boolean. */
export type Flags = Map<string, string | true>;

/** Convert Commander's camelCase option object into a kebab-case flag map. */
export function flagsFromOptions(options: Record<string, unknown>): Flags {
  const flags: Flags = new Map();
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue;
    flags.set(kebabCase(name), value === true ? true : String(value));
  }
  return flags;
}

export function requiredFlag(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (!value || value === true) throw new Error(`--${name} is required`);
  return value;
}

export function optionalFlag(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

export function rejectUnknownFlags(
  flags: Flags,
  allowed: ReadonlySet<string>,
): void {
  for (const name of flags.keys())
    if (!allowed.has(name)) throw new Error(`Unknown flag: --${name}`);
}

export function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`--${name} must be a positive integer`);
  return number;
}

export function nonnegativeInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`--${name} must be a nonnegative integer`);
  return number;
}

export function unitInterval(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw new Error(`--${name} must be a number between 0 and 1`);
  return number;
}

export function enumeration<T extends string>(
  value: string,
  name: string,
  allowed: readonly T[],
): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined)
    throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
  return match;
}

/** `candidate-limit` -> `candidateLimit`. */
export function camelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** `temporalWithin` -> `temporal-within`. */
export function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function parseJsonObject(raw: string, name: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `--${name} must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`--${name} must be a JSON object`);
  return parsed;
}
