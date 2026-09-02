// Flag plumbing for `searchgres-server`.
//
// Intentionally a separate copy from the equivalent in `packages/cli`: `searchgres` and
// `searchgres-server` share no code. They are different tools with different privileges
// — one holds database and provider credentials, the other only a server URL —
// and coupling them through a helper module would create a dependency edge
// between the privileged and unprivileged binaries for the sake of a few
// one-line validators. The duplication is the cheaper of the two.

/** A parsed command line: kebab-case flag name to value, or `true` if boolean. */
export type Flags = Map<string, string | true>;

/** Convert Commander's camelCase option object into a kebab-case flag map. */
export function flagsFromOptions(options: Record<string, unknown>): Flags {
  const flags: Flags = new Map();
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    // Commander represents an explicitly supplied negated option such as
    // `--no-env-file` as `{ envFile: false }`; absent options are omitted.
    if (value === false) {
      flags.set(`no-${flag}`, true);
    } else {
      flags.set(flag, value === true ? true : String(value));
    }
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

/** A listen host that needs no `--allow-public-listen` acknowledgement. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
