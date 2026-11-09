import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Database access and tenancy.
 *
 * Every request opens one transaction, sets the tenancy GUCs, and does its work inside it. The
 * application also filters by org explicitly; row-level security is the net that catches the query
 * where someone forgot (docs/11-data-model.md).
 */

export type Sql = postgres.Sql<Record<string, unknown>>;
/** A transaction handle. Every tenant-scoped query runs on one of these, never on the pool. */
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

export interface TenantContext {
  orgId: string;
  userId: string | null;
  isStaff?: boolean;
}

export interface ConnectOptions {
  url: string;
  max?: number;
  /** Statement timeout in milliseconds; a request should never hold a connection open forever. */
  statementTimeoutMs?: number;
}

export function connect({ url, max = 10, statementTimeoutMs = 15_000 }: ConnectOptions): Sql {
  return postgres(url, {
    max,
    prepare: false,
    connection: { statement_timeout: statementTimeoutMs },
    onnotice: () => {},
  });
}

/**
 * Runs `fn` inside a transaction scoped to one organisation.
 *
 * `set_local` means the settings die with the transaction, so a pooled connection can never leak
 * one tenant's context into another's request.
 */
export async function withTenant<T>(
  sql: Sql,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${ctx.orgId}, true),
                    set_config('app.user_id', ${ctx.userId ?? ''}, true),
                    set_config('app.is_staff', ${ctx.isStaff ? 'on' : 'off'}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Runs `fn` with no tenant context at all.
 *
 * Used by the paths that legitimately precede a session — signing in, accepting an invitation — and
 * by migrations. Everything else goes through {@link withTenant}.
 */
export async function withoutTenant<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => fn(tx)) as Promise<T>;
}

/**
 * Runs `fn` with staff privileges and no organisation.
 *
 * Staff genuinely need to cross tenants — publishing packs, operating the render queue — and the
 * policies allow exactly that, which is why every staff action is written to the audit log.
 */
export async function withStaff<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', '', true),
                    set_config('app.user_id', '', true),
                    set_config('app.is_staff', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Runs `fn` with the system context: the narrow cross-tenant access the account lifecycle needs.
 *
 * Sign-in, invitation acceptance and password reset all begin with a token and no session, so they
 * must look up a row before they know which tenant it belongs to. The token is the authorization;
 * this context only widens the reach to the tables that lifecycle touches (see migration 0002), and
 * never to designs, artwork or renders.
 */
export async function withSystem<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', '', true),
                    set_config('app.user_id', '', true),
                    set_config('app.is_staff', 'off', true),
                    set_config('app.is_system', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Applies pending migrations in filename order, once each, inside a transaction per file. */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;

  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    const [existing] = await sql`select name from schema_migrations where name = ${file}`;
    if (existing) {
      alreadyApplied.push(file);
      continue;
    }

    const contents = readFileSync(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    applied.push(file);
  }

  return { applied, alreadyApplied };
}

/** Drops everything this schema owns. Test helper; never wired into the application. */
export async function resetDatabase(sql: Sql): Promise<void> {
  await sql.unsafe('drop schema public cascade; create schema public;');
}

/** UUIDv7: time-ordered, so primary keys cluster by creation and indexes stay tidy. */
export function uuidv7(now = Date.now(), random = crypto.getRandomValues.bind(crypto)): string {
  const bytes = new Uint8Array(16);
  random(bytes.subarray(6));

  const timestamp = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((timestamp >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
