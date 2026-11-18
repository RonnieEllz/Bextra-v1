import { Injectable } from '@nestjs/common';
import { createVerify } from 'node:crypto';
import pg from 'pg';
import { tapBatchSchema } from '@bextra/shared';
import { database } from '../../database.js';

export interface TapOutcome {
  tapId: string;
  status: 'posted' | 'duplicate' | 'rejected';
  rejectReason?: string;
  transactionId?: string;
}

@Injectable()
export class GatewayService {
  async uploadBatch(body: unknown, idempotencyKey: string, requestId?: string) {
    if (!idempotencyKey) throw Object.assign(new Error('Idempotency key required'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const parsed = tapBatchSchema.safeParse(body);
    if (!parsed.success) throw Object.assign(new Error(parsed.error.message), { status: 400, code: 'VALIDATION_ERROR' });
    const input = parsed.data;

    const batch = await database.query(
      `INSERT INTO batches(operator_id, terminal_id, batch_id, declared_count)
       SELECT operator_id, id, $1, $2 FROM terminals WHERE id = $3
       ON CONFLICT (batch_id) DO UPDATE SET declared_count = EXCLUDED.declared_count
       RETURNING id, operator_id`,
      [input.batchId, input.declaredCount, input.terminalId],
    );
    if (!batch.rows[0]) throw Object.assign(new Error('Unknown terminal'), { status: 404, code: 'TERMINAL_NOT_FOUND' });

    const outcomes: TapOutcome[] = [];
    for (const tap of input.taps) {
      outcomes.push(await this.processTap(batch.rows[0], tap, requestId));
    }
    await database.query(
      `UPDATE batches SET processed_count = $1, status = 'processed'
       WHERE batch_id = $2`,
      [outcomes.filter((item) => item.status !== 'rejected').length, input.batchId],
    );
    return {
      batchId: input.batchId,
      latestBlockedListVersion: input.blockedListVersion,
      outcomes,
    };
  }

  private async processTap(batch: { id: string; operator_id: string }, tap: TapBatchTap, requestId?: string): Promise<TapOutcome> {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tap.tapId]);

      const existing = await client.query('SELECT status, posted_transaction_id FROM taps WHERE tap_id = $1', [tap.tapId]);
      if (existing.rowCount) {
        await client.query('COMMIT');
        return {
          tapId: tap.tapId,
          status: 'duplicate',
          transactionId: existing.rows[0].posted_transaction_id ?? undefined,
        };
      }

      const terminal = await client.query(
        'SELECT id, operator_id, public_key FROM terminals WHERE id = $1',
        [tap.terminalId],
      );
      if (!terminal.rowCount || terminal.rows[0].operator_id !== batch.operator_id) {
        await this.insertRejected(client, batch, tap, 'UNKNOWN_TERMINAL');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'UNKNOWN_TERMINAL' };
      }

      const signatureValid = terminal.rows[0].public_key
        ? verifySignature(terminal.rows[0].public_key, tap.signature, canonicalTap(tap))
        : false;
      if (!signatureValid) {
        await this.insertRejected(client, batch, tap, 'INVALID_SIGNATURE');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'INVALID_SIGNATURE' };
      }

      const card = await client.query(
        `SELECT c.id, c.customer_id, c.status, c.counter, c.offline_allowance_minor, c.operator_id
         FROM cards c WHERE c.card_token = $1`,
        [tap.cardToken],
      );
      if (!card.rowCount || card.rows[0].operator_id !== batch.operator_id) {
        await this.insertRejected(client, batch, tap, 'UNKNOWN_CARD');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'UNKNOWN_CARD' };
      }
      if (card.rows[0].status !== 'active') {
        await this.insertRejected(client, batch, tap, 'CARD_BLOCKED');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'CARD_BLOCKED' };
      }
      if (tap.counter <= Number(card.rows[0].counter)) {
        await this.insertRejected(client, batch, tap, 'COUNTER_REPLAY');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'COUNTER_REPLAY' };
      }

      const tapTime = new Date(tap.tappedAt);
      const serverTime = new Date();
      if (!Number.isFinite(tapTime.getTime()) ||
          tapTime.getTime() > serverTime.getTime() + 5 * 60 * 1000 ||
          tapTime.getTime() < serverTime.getTime() - 24 * 60 * 60 * 1000) {
        await this.insertRejected(client, batch, tap, 'STALE_OR_FUTURE_TIMESTAMP');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'STALE_OR_FUTURE_TIMESTAMP' };
      }

      const fare = await client.query(
        `SELECT fare_minor FROM fare_rules
         WHERE operator_id = $1 AND route_id = $2
           AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
         ORDER BY valid_from DESC LIMIT 1`,
        [batch.operator_id, tap.routeId, tap.tappedAt],
      );
      if (!fare.rowCount) {
        await this.insertRejected(client, batch, tap, 'FARE_NOT_FOUND');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'FARE_NOT_FOUND' };
      }
      const fareMinor = BigInt(fare.rows[0].fare_minor);

      const header = await client.query(
        `INSERT INTO transactions(operator_id, idempotency_key, event_type, description)
         VALUES ($1, $2, 'fare', $3) RETURNING id`,
        [batch.operator_id, `tap:${tap.tapId}`, `NFC fare ${tap.tapId}`],
      );
      const transactionId = header.rows[0].id;

      const wallet = await client.query(
        `SELECT id FROM accounts
         WHERE operator_id = $1 AND customer_id = $2 AND code = 'CUSTOMER_WALLET'`,
        [batch.operator_id, card.rows[0].customer_id],
      );
      const payable = await client.query(
        `SELECT id FROM accounts
         WHERE operator_id = $1 AND code = 'OPERATOR_PAYABLE'`,
        [batch.operator_id],
      );
      const fee = await client.query(
        `SELECT id FROM accounts
         WHERE operator_id = $1 AND code = 'PLATFORM_FEE'`,
        [batch.operator_id],
      );
      if (!wallet.rowCount || !payable.rowCount || !fee.rowCount) {
        throw new Error('Required ledger accounts are missing');
      }

      const platformFeeMinor = 0n;
      const operatorMinor = fareMinor - platformFeeMinor;
      const balance = await client.query(
        `SELECT COALESCE(SUM(credit_minor - debit_minor), 0)::bigint AS balance
         FROM ledger_entries WHERE account_id = $1`,
        [wallet.rows[0].id],
      );
      const currentBalance = BigInt(balance.rows[0].balance);
      const finalBalance = currentBalance - fareMinor;
      const offlineAllowance = BigInt(card.rows[0].offline_allowance_minor);
      if (tap.offlineFlag && finalBalance < -offlineAllowance) {
        await this.insertRejected(client, batch, tap, 'OFFLINE_ALLOWANCE_EXCEEDED');
        await client.query('COMMIT');
        return { tapId: tap.tapId, status: 'rejected', rejectReason: 'OFFLINE_ALLOWANCE_EXCEEDED' };
      }
      await client.query(
        `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
         VALUES ($1, $2, $3, 0), ($1, $4, 0, $5)`,
        [transactionId, wallet.rows[0].id, fareMinor, payable.rows[0].id, operatorMinor],
      );

      const postedTap = await client.query(
        `INSERT INTO taps(operator_id, tap_id, batch_id, card_id, terminal_id, route_id,
          tapped_at, counter, claimed_fare_minor, settled_fare_minor, offline_flag,
          signature, status, posted_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'posted', $13)
         RETURNING id`,
        [batch.operator_id, tap.tapId, batch.id, card.rows[0].id, tap.terminalId, tap.routeId,
          tap.tappedAt, tap.counter, tap.claimedFareMinor, fareMinor.toString(), tap.offlineFlag,
          '[redacted]', transactionId],
      );
      if (tap.claimedFareMinor !== Number(fareMinor)) {
        await client.query(
          `INSERT INTO risk_events(operator_id, tap_id, event_type, severity, details)
           VALUES ($1, $2, 'fare_mismatch', 'medium', $3::jsonb)`,
          [batch.operator_id, postedTap.rows[0].id, JSON.stringify({
            claimedFareMinor: tap.claimedFareMinor,
            settledFareMinor: Number(fareMinor),
          })],
        );
      }
      if (tap.offlineFlag && finalBalance < 0n) {
        await client.query(
          `INSERT INTO risk_events(operator_id, tap_id, event_type, severity, details)
           VALUES ($1, $2, 'offline_overdraft', 'high', $3::jsonb)`,
          [batch.operator_id, postedTap.rows[0].id, JSON.stringify({
            resultingBalanceMinor: Number(finalBalance),
            allowanceMinor: Number(offlineAllowance),
          })],
        );
      }
      if (tap.counter > Number(card.rows[0].counter) + 1) {
        await client.query(
          `INSERT INTO risk_events(operator_id, tap_id, event_type, severity, details)
           VALUES ($1, $2, 'counter_gap', 'medium', $3::jsonb)`,
          [batch.operator_id, postedTap.rows[0].id, JSON.stringify({
            previousCounter: Number(card.rows[0].counter),
            receivedCounter: tap.counter,
          })],
        );
      }
      await client.query('UPDATE cards SET counter = $1 WHERE id = $2', [tap.counter, card.rows[0].id]);
      await client.query('COMMIT');
      return { tapId: tap.tapId, status: 'posted', transactionId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertRejected(client: pg.PoolClient, batch: { id: string; operator_id: string }, tap: TapBatchTap, reason: string) {
    await client.query(
      `INSERT INTO taps(operator_id, tap_id, batch_id, terminal_id, route_id, tapped_at,
       counter, claimed_fare_minor, offline_flag, signature, status, reject_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[redacted]', 'rejected', $10)`,
      [batch.operator_id, tap.tapId, batch.id, tap.terminalId, tap.routeId, tap.tappedAt,
       tap.counter, tap.claimedFareMinor, tap.offlineFlag, reason],
    );
  }
}

interface TapBatchTap {
  tapId: string;
  cardToken: string;
  terminalId: string;
  routeId: string;
  tappedAt: string;
  counter: number;
  claimedFareMinor: number;
  offlineFlag: boolean;
  signature: string;
}

function canonicalTap(tap: TapBatchTap): Buffer {
  return Buffer.from(JSON.stringify({
    tapId: tap.tapId,
    cardToken: tap.cardToken,
    terminalId: tap.terminalId,
    routeId: tap.routeId,
    tappedAt: tap.tappedAt,
    counter: tap.counter,
    claimedFareMinor: tap.claimedFareMinor,
  }));
}

function verifySignature(publicKeyPem: string, signatureBase64: string, payload: Buffer): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(payload);
    verifier.end();
    return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
