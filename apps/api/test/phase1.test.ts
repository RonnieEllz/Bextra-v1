import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateKeyPairSync } from 'node:crypto';
import { signTap } from '@bextra/shared';
import { GatewayService } from '../src/modules/gateway/gateway.service.js';
import { FundingService } from '../src/modules/funding/funding.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('concurrent tap upload charges once and a mixed batch rejects only invalid taps', async (t) => {
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const keyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1`,
  );
  assert.equal(operator.rowCount, 1);
  const operatorId = operator.rows[0].id;

  const terminal = await pool.query(
    `SELECT id FROM terminals WHERE operator_id = $1 LIMIT 1`,
    [operatorId],
  );
  assert.equal(terminal.rowCount, 1);
  const terminalId = terminal.rows[0].id;
  await pool.query(
    `UPDATE terminals SET public_key = $1, blocked_list_version = 0 WHERE id = $2`,
    [keyPair.publicKey, terminalId],
  );
  await pool.query(
    `DELETE FROM risk_events
     WHERE tap_id IN (SELECT id FROM taps WHERE terminal_id = $1)`,
    [terminalId],
  );
  await pool.query(
    `DELETE FROM taps WHERE terminal_id = $1`,
    [terminalId],
  );

  const route = await pool.query(
    `SELECT id FROM routes WHERE operator_id = $1 LIMIT 1`,
    [operatorId],
  );
  const card = await pool.query(
    `SELECT id, card_token, customer_id FROM cards
     WHERE operator_id = $1 AND card_token = 'BE-TEST-CARD-001'`,
    [operatorId],
  );
  await pool.query(
    `UPDATE cards SET status = 'active', counter = 0 WHERE id = $1`,
    [card.rows[0].id],
  );

  const gateway = new GatewayService();
  const concurrentTapId = crypto.randomUUID();
  const payload = {
    tapId: concurrentTapId,
    cardToken: card.rows[0].card_token,
    terminalId,
    routeId: route.rows[0].id,
    tappedAt: new Date().toISOString(),
    counter: 1,
    claimedFareMinor: 500,
  };
  const tap = {
    ...payload,
    offlineFlag: false,
    signature: signTap(keyPair.privateKey, payload),
  };
  const batch = {
    terminalId,
    batchId: crypto.randomUUID(),
    declaredCount: 1,
    blockedListVersion: 0,
    taps: [tap],
  };

  const uploads = await Promise.all([
    gateway.uploadBatch(batch, crypto.randomUUID()),
    gateway.uploadBatch(batch, crypto.randomUUID()),
    gateway.uploadBatch(batch, crypto.randomUUID()),
  ]);
  assert.equal(uploads.filter((item) => item.outcomes[0]?.status === 'posted').length, 1);
  assert.equal(uploads.filter((item) => item.outcomes[0]?.status === 'duplicate').length, 2);

  const posted = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM taps WHERE tap_id = $1 AND status = 'posted'`,
    [concurrentTapId],
  );
  assert.equal(posted.rows[0].count, 1);

  const mixedTaps = Array.from({ length: 20 }, (_, index) => {
    const tapPayload = {
      tapId: crypto.randomUUID(),
      cardToken: card.rows[0].card_token,
      terminalId,
      routeId: route.rows[0].id,
      tappedAt: new Date().toISOString(),
      counter: index + 2,
      claimedFareMinor: 500,
    };
    return {
      ...tapPayload,
      offlineFlag: false,
      signature: index === 7 ? 'invalid-signature' : signTap(keyPair.privateKey, tapPayload),
    };
  });
  const mixedResult = await gateway.uploadBatch({
    terminalId,
    batchId: crypto.randomUUID(),
    declaredCount: 20,
    blockedListVersion: 0,
    taps: mixedTaps,
  }, crypto.randomUUID());

  assert.equal(mixedResult.outcomes.filter((item) => item.status === 'posted').length, 19);
  assert.equal(mixedResult.outcomes.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(
    mixedResult.outcomes.filter((item) => item.rejectReason === 'INVALID_SIGNATURE').length,
    1,
  );

  await pool.end();
});

test('concurrent identical agent top-ups credit once and insufficient float is refused', async (t) => {
  if (!databaseUrl) {
    t.diagnostic('TEST_DATABASE_URL is not set');
    t.skip();
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const operator = await pool.query(
    `SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1`,
  );
  const agent = await pool.query(
    `SELECT id FROM agents WHERE operator_id = $1 LIMIT 1`,
    [operator.rows[0].id],
  );
  const card = await pool.query(
    `SELECT id FROM cards
     WHERE operator_id = $1 AND card_token = 'BE-TEST-CARD-001'`,
    [operator.rows[0].id],
  );
  const floatAccount = await pool.query(
    `SELECT float_account_id FROM agents WHERE id = $1`,
    [agent.rows[0].id],
  );
  const clearing = await pool.query(
    `SELECT id FROM accounts
     WHERE operator_id = $1 AND code = 'PLATFORM_CLEARING'`,
    [operator.rows[0].id],
  );
  const floatBalance = await pool.query(
    `SELECT COALESCE(SUM(credit_minor - debit_minor), 0)::bigint AS balance
     FROM ledger_entries WHERE account_id = $1`,
    [floatAccount.rows[0].float_account_id],
  );
  if (BigInt(floatBalance.rows[0].balance) < 100000n) {
    const resetKey = `test:float-reset:${crypto.randomUUID()}`;
    await pool.query('BEGIN');
    const resetHeader = await pool.query(
      `INSERT INTO transactions(operator_id, idempotency_key, event_type)
       VALUES ($1, $2, 'test_float_topup') RETURNING id`,
      [operator.rows[0].id, resetKey],
    );
    await pool.query(
      `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
       VALUES ($1, $2, 1000000, 0), ($1, $3, 0, 1000000)`,
      [resetHeader.rows[0].id, clearing.rows[0].id, floatAccount.rows[0].float_account_id],
    );
    await pool.query('COMMIT');
  }
  const funding = new FundingService();
  const key = `test-topup-${crypto.randomUUID()}`;
  const body = { agentId: agent.rows[0].id, cardId: card.rows[0].id, amountMinor: 1000 };

  const results = await Promise.all([
    funding.topUp(body, key),
    funding.topUp(body, key),
    funding.topUp(body, key),
  ]);
  assert.equal(results.filter((item) => item.status === 'confirmed').length, 1);
  assert.equal(results.filter((item) => item.status === 'duplicate').length, 2);

  const requestCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM funding_requests WHERE idempotency_key = $1`,
    [key],
  );
  assert.equal(requestCount.rows[0].count, 1);

  await assert.rejects(
    funding.topUp(
      { agentId: agent.rows[0].id, cardId: card.rows[0].id, amountMinor: 99_999_999_999 },
      `test-insufficient-${crypto.randomUUID()}`,
    ),
    (error: unknown) => (error as { code?: string }).code === 'INSUFFICIENT_FLOAT',
  );

  await pool.end();
});
