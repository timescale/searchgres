import postgres, { type Sql } from "postgres";

const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres@127.0.0.1:5432/postgres";
const SCHEMA_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function connect(): Sql {
  return postgres(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL, {
    onnotice: () => {},
  });
}

/** Generate a valid test-only schema name that cannot collide with production. */
export function randomTestSchema(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let suffix = "";
  for (const byte of bytes) {
    suffix += SCHEMA_ALPHABET[byte % SCHEMA_ALPHABET.length];
  }
  return `sgtest_${suffix}`;
}

export async function dropTestSchema(sql: Sql, schema: string): Promise<void> {
  await sql`drop schema if exists ${sql(schema)} cascade`;
}
