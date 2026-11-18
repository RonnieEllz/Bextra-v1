import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const testUrl = process.env.TEST_DATABASE_URL;

test('ledger rows are append-only and transactions must balance', async (t) => {
  if (!testUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }

  const pool = new pg.Pool({ connectionString: testUrl });
  await pool.query('TRUNCATE ledger_entries, transactions CASCADE');

  await assert.rejects(async () => {
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO transactions(idempotency_key, event_type) VALUES ('test-unbalanced', 'test')`,
    );
    await pool.query(
      `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
       SELECT id, (SELECT id FROM accounts LIMIT 1), 100, 0
       FROM transactions WHERE idempotency_key = 'test-unbalanced'`,
    );
    await pool.query('COMMIT');
  });

  await pool.query('ROLLBACK').catch(() => undefined);

  const account = await pool.query('SELECT id FROM accounts LIMIT 1');
  assert.ok(account.rowCount);
  await pool.query('BEGIN');
  const transaction = await pool.query(
    `INSERT INTO transactions(idempotency_key, event_type)
     VALUES ('test-balanced', 'test') RETURNING id`,
  );
  await pool.query(
    `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
     VALUES ($1, $2, 100, 0), ($1, $2, 0, 100)`,
    [transaction.rows[0].id, account.rows[0].id],
  );
  await pool.query('COMMIT');

  await assert.rejects(pool.query(
    `UPDATE ledger_entries SET debit_minor = 200
     WHERE transaction_id = (SELECT id FROM transactions WHERE idempotency_key = 'test-balanced')`,
  ));

  await assert.rejects(pool.query(
    `DELETE FROM ledger_entries
     WHERE transaction_id = (SELECT id FROM transactions WHERE idempotency_key = 'test-balanced')`,
  ));
  await pool.end();
});
