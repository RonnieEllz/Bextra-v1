import { Injectable } from '@nestjs/common';
import { database } from '../../database.js';

@Injectable()
export class SettlementService {
  async run(operatorId: string, businessDay: string, key: string) {
    if (!key) throw Object.assign(new Error('Idempotency key required'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const totals = await database.query(
      `SELECT
         COALESCE(SUM(settled_fare_minor) FILTER (WHERE status = 'posted'), 0)::bigint AS posted,
         COALESCE(COUNT(*) FILTER (WHERE status = 'posted'), 0)::bigint AS posted_count,
         COALESCE(COUNT(*) FILTER (WHERE status = 'rejected'), 0)::bigint AS rejected
       FROM taps
       WHERE operator_id = $1 AND (tapped_at AT TIME ZONE 'Africa/Blantyre')::date = $2::date`,
      [operatorId, businessDay],
    );
    const offline = await database.query(
      `SELECT COUNT(*)::int AS count FROM taps
       WHERE operator_id = $1 AND offline_flag = true
         AND status <> 'posted'
         AND (tapped_at AT TIME ZONE 'Africa/Blantyre')::date = $2::date`,
      [operatorId, businessDay],
    );
    const expected = await database.query(
      `SELECT COALESCE(SUM(b.declared_count), 0)::bigint AS declared
       FROM batches b WHERE b.operator_id = $1`,
      [operatorId],
    );
    const posted = BigInt(totals.rows[0].posted);
    const postedCount = BigInt(totals.rows[0].posted_count);
    const declared = BigInt(expected.rows[0].declared);
    const unsettled = offline.rows[0].count > 0 || declared !== postedCount;
    const status = unsettled ? 'locked' : 'approved';
    const inserted = await database.query(
      `INSERT INTO settlements(operator_id, business_day, expected_minor, posted_minor, difference_minor, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(operator_id, business_day) DO UPDATE
       SET posted_minor = EXCLUDED.posted_minor,
           difference_minor = EXCLUDED.difference_minor,
           status = CASE WHEN settlements.status = 'approved' THEN 'approved' ELSE EXCLUDED.status END
       RETURNING *`,
      [operatorId, businessDay, posted, posted, '0', status],
    );
    return inserted.rows[0];
  }

  async override(id: string, body: { operatorId: string; actorId: string; reason: string }, key: string) {
    if (!key) throw Object.assign(new Error('Idempotency key required'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    if (!body.reason?.trim()) throw Object.assign(new Error('Written override reason required'), { status: 400, code: 'REASON_REQUIRED' });
    const result = await database.query(
      `UPDATE settlements SET status = 'approved', override_reason = $1,
       override_actor_id = $2, override_at = now()
       WHERE id = $3 AND operator_id = $4 AND status = 'locked'
       RETURNING *`,
      [body.reason.trim(), body.actorId, id, body.operatorId],
    );
    if (!result.rowCount) throw Object.assign(new Error('Settlement not found or not locked'), { status: 409, code: 'SETTLEMENT_NOT_OVERRIDEABLE' });
    await database.query(
      `INSERT INTO audit_log(actor_id, operator_id, action, reason, details)
       VALUES ($1, $2, 'settlement_override', $3, $4::jsonb)`,
      [body.actorId, body.operatorId, body.reason.trim(), JSON.stringify({ settlementId: id, idempotencyKey: key })],
    );
    return result.rows[0];
  }

  async payout(id: string, body: { operatorId: string; actorId: string }, key: string) {
    if (!key) throw Object.assign(new Error('Idempotency key required'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`settlement-payout:${id}`]);
      const existing = await client.query(
        `SELECT id FROM transactions WHERE idempotency_key = $1`,
        [`payout:${key}:${id}`],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return { status: 'duplicate', settlementId: id, transactionId: existing.rows[0].id };
      }
      const settlement = await client.query(
        `SELECT * FROM settlements WHERE id = $1 AND operator_id = $2`,
        [id, body.operatorId],
      );
      if (!settlement.rowCount) {
        throw Object.assign(new Error('Settlement not found'), { status: 404, code: 'SETTLEMENT_NOT_FOUND' });
      }
      if (settlement.rows[0].status !== 'approved') {
        throw Object.assign(new Error('Settlement must be approved before payout'), { status: 409, code: 'SETTLEMENT_NOT_APPROVED' });
      }
      const payable = await client.query(
        `SELECT id FROM accounts WHERE operator_id = $1 AND code = 'OPERATOR_PAYABLE'`,
        [body.operatorId],
      );
      const clearing = await client.query(
        `SELECT id FROM accounts WHERE operator_id = $1 AND code = 'PLATFORM_CLEARING'`,
        [body.operatorId],
      );
      if (!payable.rowCount || !clearing.rowCount) {
        throw new Error('Required settlement accounts are missing');
      }
      const amount = BigInt(settlement.rows[0].posted_minor);
      if (amount <= 0n) {
        throw Object.assign(new Error('Settlement has no payout amount'), { status: 409, code: 'ZERO_PAYOUT' });
      }
      const transaction = await client.query(
        `INSERT INTO transactions(operator_id, idempotency_key, event_type)
         VALUES ($1, $2, 'operator_payout') RETURNING id`,
        [body.operatorId, `payout:${key}:${id}`],
      );
      await client.query(
        `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
         VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
        [transaction.rows[0].id, payable.rows[0].id, amount.toString(), clearing.rows[0].id],
      );
      await client.query(
        `UPDATE settlements SET status = 'paid' WHERE id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO audit_log(actor_id, operator_id, action, reason, details)
         VALUES ($1, $2, 'settlement_payout', 'operator payout', $3::jsonb)`,
        [body.actorId, body.operatorId, JSON.stringify({ settlementId: id, transactionId: transaction.rows[0].id })],
      );
      await client.query('COMMIT');
      return { status: 'paid', settlementId: id, transactionId: transaction.rows[0].id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
