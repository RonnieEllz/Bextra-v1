import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { topUpSchema } from '@bextra/shared';
import { database } from '../../database.js';

@Injectable()
export class FundingService {
  async topUp(body: unknown, key: string, requestId?: string, operatorId?: string, authenticatedAgentId?: string) {
    if (!key) throw Object.assign(new Error('An idempotency key is required'), { status: 400, code: 'IDEMPOTENCY_NOT_FOUND' });
    const parsed = topUpSchema.safeParse(body);
    if (!parsed.success) {
      const invalidAmount = parsed.error.issues.some((issue) => issue.path.includes('amountMinor'));
      throw Object.assign(new Error(parsed.error.message), { status: 400, code: invalidAmount ? 'INVALID_AMOUNT' : 'VALIDATION_ERROR' });
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      operatorId: operatorId ?? null,
      agentId: parsed.data.agentId,
      cardId: parsed.data.cardId,
      cardToken: parsed.data.cardToken ?? null,
      amountMinor: parsed.data.amountMinor,
    })).digest('hex');
    const existingResult = (row: { request_hash: string | null; response: Record<string, unknown> | null }) => {
      if (row.request_hash && row.request_hash !== requestHash) {
        throw Object.assign(new Error('Idempotency key was already used with a different request'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      }
      if (!row.response) {
        throw Object.assign(new Error('The idempotent request has no completed result'), { status: 409, code: 'IDEMPOTENCY_NOT_FOUND' });
      }
      if (typeof row.response.status !== 'string') {
        throw Object.assign(new Error('The idempotent request result is invalid'), { status: 409, code: 'IDEMPOTENCY_NOT_FOUND' });
      }
      const duplicateResponse: Record<string, unknown> = { ...row.response, duplicate: true };
      return duplicateResponse;
    };

    const existing = await database.query(
      'SELECT request_hash, response FROM funding_requests WHERE idempotency_key = $1',
      [key],
    );
    if (existing.rowCount) return existingResult(existing.rows[0]);

    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`funding:${key}`]);
      const lockedExisting = await client.query(
        'SELECT request_hash, response FROM funding_requests WHERE idempotency_key = $1',
        [key],
      );
      if (lockedExisting.rowCount) {
        await client.query('COMMIT');
        return existingResult(lockedExisting.rows[0]);
      }
      const agent = await client.query(
        'SELECT id, operator_id, float_account_id, commission_bps, status FROM agents WHERE id = $1 FOR UPDATE',
        [parsed.data.agentId],
      );
      if (!agent.rowCount) throw Object.assign(new Error('Agent not found'), { status: 404, code: 'AGENT_NOT_FOUND' });
      if (agent.rows[0].status !== 'active') throw Object.assign(new Error('Agent is not active'), { status: 403, code: 'FORBIDDEN' });
      if (authenticatedAgentId && agent.rows[0].id !== authenticatedAgentId) {
        throw Object.assign(new Error('Agent access denied'), { status: 403, code: 'FORBIDDEN' });
      }
      const card = await client.query(
        'SELECT id, operator_id, customer_id, card_token, status FROM cards WHERE id = $1 FOR UPDATE',
        [parsed.data.cardId],
      );
      if (!card.rowCount) throw Object.assign(new Error('Card not found'), { status: 404, code: 'CARD_NOT_FOUND' });
      if (parsed.data.cardToken && parsed.data.cardToken !== card.rows[0].card_token) {
        throw Object.assign(new Error('Card token does not match card ID'), { status: 404, code: 'CARD_NOT_FOUND' });
      }
      if (card.rows[0].status !== 'active') throw Object.assign(new Error('Card is blocked'), { status: 409, code: 'CARD_BLOCKED' });
      if (agent.rows[0].operator_id !== card.rows[0].operator_id) {
        throw Object.assign(new Error('Tenant mismatch'), { status: 403, code: 'TENANT_MISMATCH' });
      }
      if (operatorId && agent.rows[0].operator_id !== operatorId) {
        throw Object.assign(new Error('Cross-tenant access denied'), { status: 403, code: 'TENANT_MISMATCH' });
      }

      const funding = await client.query(
        `INSERT INTO funding_requests(operator_id, idempotency_key, agent_id, card_id, amount_minor)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [agent.rows[0].operator_id, key, agent.rows[0].id, card.rows[0].id, parsed.data.amountMinor],
      );

      const wallet = await client.query(
        `SELECT id FROM accounts WHERE operator_id = $1 AND customer_id = $2 AND code = 'CUSTOMER_WALLET'`,
        [agent.rows[0].operator_id, card.rows[0].customer_id],
      );
      if (!wallet.rowCount) throw Object.assign(new Error('Customer wallet not found'), { status: 409, code: 'WALLET_NOT_FOUND' });

      await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [agent.rows[0].float_account_id]);
      const floatBalance = await client.query(
        `SELECT COALESCE(SUM(credit_minor - debit_minor), 0)::bigint AS balance
         FROM ledger_entries WHERE account_id = $1`,
        [agent.rows[0].float_account_id],
      );
      if (BigInt(floatBalance.rows[0].balance) < BigInt(parsed.data.amountMinor)) {
        throw Object.assign(new Error('Insufficient agent float'), { status: 409, code: 'INSUFFICIENT_FLOAT' });
      }

      const commissionBps = Number(agent.rows[0].commission_bps ?? 0);
      const commissionMinor = (BigInt(parsed.data.amountMinor) * BigInt(commissionBps)) / 10000n;
      const commissionExpense = await client.query(
        `SELECT id FROM accounts WHERE operator_id = $1 AND code = 'COMMISSION_EXPENSE'`,
        [agent.rows[0].operator_id],
      );
      const commissionPayable = await client.query(
        `SELECT id FROM accounts WHERE operator_id = $1 AND code = 'COMMISSION_PAYABLE'`,
        [agent.rows[0].operator_id],
      );
      if (!commissionExpense.rowCount || !commissionPayable.rowCount) {
        throw new Error('Required commission accounts are missing');
      }

      const transaction = await client.query(
        `INSERT INTO transactions(operator_id, idempotency_key, event_type)
         VALUES ($1, $2, 'agent_topup') RETURNING id`,
        [agent.rows[0].operator_id, `topup:${key}`],
      );
      if (commissionMinor > 0n) {
        await client.query(
          `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3),
                  ($1, $5, $6, 0), ($1, $7, 0, $6)`,
          [transaction.rows[0].id, agent.rows[0].float_account_id, parsed.data.amountMinor,
            wallet.rows[0].id, commissionExpense.rows[0].id, commissionMinor,
            commissionPayable.rows[0].id],
        );
      } else {
        await client.query(
          `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
          [transaction.rows[0].id, agent.rows[0].float_account_id, parsed.data.amountMinor,
            wallet.rows[0].id],
        );
      }
      await client.query(`UPDATE funding_requests SET status = 'confirmed' WHERE id = $1`, [funding.rows[0].id]);
      const remainingFloatMinor = BigInt(floatBalance.rows[0].balance) - BigInt(parsed.data.amountMinor);
      const confirmedAt = new Date().toISOString();
      const response = {
        status: 'confirmed',
        fundingRequestId: funding.rows[0].id,
        transactionId: transaction.rows[0].id,
        cardToken: card.rows[0].card_token,
        amountMinor: parsed.data.amountMinor,
        commissionMinor: Number(commissionMinor),
        remainingAgentFloatMinor: Number(remainingFloatMinor),
        confirmedAt,
      };
      await client.query(
        `UPDATE funding_requests SET transaction_id = $1, commission_minor = $2,
           request_hash = $3, response = $4::jsonb, confirmed_at = $5
         WHERE id = $6`,
        [transaction.rows[0].id, commissionMinor.toString(), requestHash, JSON.stringify(response), confirmedAt, funding.rows[0].id],
      );
      await client.query(
        `INSERT INTO audit_log(actor_role, operator_id, action, request_id, details)
         VALUES ('agent', $1, 'agent_topup', $2, $3::jsonb)`,
        [agent.rows[0].operator_id, requestId ?? null, JSON.stringify({ idempotencyKey: key, agentId: parsed.data.agentId })],
      );
      await client.query(
        `INSERT INTO agent_daily_stats(agent_id, business_day, cash_taken_minor, topup_count, commission_minor)
         VALUES ($1, (now() AT TIME ZONE 'Africa/Blantyre')::date, $2, 1, $3)
         ON CONFLICT(agent_id, business_day) DO UPDATE
         SET cash_taken_minor = agent_daily_stats.cash_taken_minor + EXCLUDED.cash_taken_minor,
             topup_count = agent_daily_stats.topup_count + 1,
             commission_minor = agent_daily_stats.commission_minor + EXCLUDED.commission_minor,
             updated_at = now()`,
        [parsed.data.agentId, parsed.data.amountMinor, commissionMinor.toString()],
      );
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async providerWebhook(body: unknown, key: string, _requestId?: string) {
    if (!key) throw Object.assign(new Error('An idempotency key is required'), { status: 400, code: 'IDEMPOTENCY_NOT_FOUND' });
    const payload = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const providerId = String(payload.providerTransactionId ?? payload.id ?? key);
    const status = String(payload.status ?? 'unknown');
    await database.query(
      `INSERT INTO provider_events(provider_transaction_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT(provider_transaction_id) DO UPDATE SET event_type = EXCLUDED.event_type`,
      [providerId, status, JSON.stringify(payload)],
    );
    return { status: 'accepted', providerTransactionId: providerId };
  }
}
