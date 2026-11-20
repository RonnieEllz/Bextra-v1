import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client, Pool } = pg;
const command = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });
const migrationsDir = path.resolve(here, '../migrations');

const devUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/bextra_dev';
const testUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/bextra_test';

function urlParts(url: string) {
  const parsed = new URL(url);
  return {
    database: parsed.pathname.slice(1),
    adminUrl: `${parsed.protocol}//${parsed.username}:${parsed.password}@${parsed.host}/postgres`,
  };
}

async function ensureDatabase(url: string) {
  const { database, adminUrl } = urlParts(url);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  await client.query('SELECT 1');
  await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [database],
  ).then(async (result) => {
    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
    }
  });
  await client.end();
}

async function migrate(url: string) {
  await ensureDatabase(url);
  const pool = new Pool({ connectionString: url });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (applied.rowCount) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  await pool.end();
}

async function reset(url: string) {
  const { database, adminUrl } = urlParts(url);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  );
  await client.query(`DROP DATABASE IF EXISTS "${database.replaceAll('"', '""')}"`);
  await client.end();
  await migrate(url);
}

async function main() {
  if (command === 'setup') {
    await ensureDatabase(devUrl);
    await ensureDatabase(testUrl);
  } else if (command === 'migrate') {
    await migrate(devUrl);
  } else if (command === 'reset-test') {
    await reset(testUrl);
  } else if (command === 'seed') {
    await migrate(devUrl);
  } else if (command === 'reset') {
    await reset(devUrl);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
