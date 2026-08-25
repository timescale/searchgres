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

export async function columnType(
  sql: Sql,
  schema: string,
  table: string,
  column: string,
): Promise<string | null> {
  const [row] = await sql<{ readonly type: string }[]>`
    select pg_catalog.format_type(a.atttypid, a.atttypmod) as type
    from pg_catalog.pg_attribute a
    where a.attrelid = ${`${schema}.${table}`}::pg_catalog.regclass
      and a.attname = ${column}
      and not a.attisdropped
  `;
  return row?.type ?? null;
}

export async function listIndexes(
  sql: Sql,
  schema: string,
  table: string,
): Promise<readonly string[]> {
  const rows = await sql<{ readonly indexname: string }[]>`
    select indexname
    from pg_catalog.pg_indexes
    where schemaname = ${schema}
      and tablename = ${table}
    order by indexname
  `;
  return rows.map((row) => row.indexname);
}

export async function indexReloptions(
  sql: Sql,
  schema: string,
  index: string,
): Promise<readonly string[]> {
  const [row] = await sql<{ readonly reloptions: readonly string[] | null }[]>`
    select c.reloptions
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relname = ${index}
  `;
  return row?.reloptions ?? [];
}

export async function indexOpclass(
  sql: Sql,
  schema: string,
  index: string,
): Promise<string | null> {
  const [row] = await sql<{ readonly opcname: string }[]>`
    select opc.opcname
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_opclass opc on opc.oid = i.indclass[0]
    where n.nspname = ${schema}
      and c.relname = ${index}
  `;
  return row?.opcname ?? null;
}

export async function listTriggers(
  sql: Sql,
  schema: string,
  table: string,
): Promise<readonly string[]> {
  const rows = await sql<{ readonly tgname: string }[]>`
    select t.tgname
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relname = ${table}
      and not t.tgisinternal
    order by t.tgname
  `;
  return rows.map((row) => row.tgname);
}
