import { Body, Controller, Get, Headers, Param, Query, Req, UseGuards } from '@nestjs/common';
import { database } from '../../database.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthContext } from '../auth/auth.types.js';
import { verifyRecentCustomerStepUp } from '../auth/auth.service.js';
import { resolveOperatorId } from '../auth/tenant.js';

type MobileRequest = { auth: AuthContext };

function pagination(pageValue?: string, pageSizeValue?: string) {
  const page = pageValue === undefined ? 1 : Number(pageValue);
  const pageSize = pageSizeValue === undefined ? 20 : Number(pageSizeValue);
  if (!Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw Object.assign(new Error('page must be positive and pageSize must be between 1 and 100'), { status: 400, code: 'INVALID_PAGINATION' });
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function asMinor(value: string | number | bigint) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error('Ledger amount exceeds the supported integer range');
  return amount;
}

@Controller('v1')
@UseGuards(AuthGuard)
export class MobileController {
  @Get('me')
  async me(@Req() request: MobileRequest) {
    const result = await database.query(
      `SELECT u.id, u.external_id, u.operator_id, r.name AS role,
              COALESCE(u.agent_id, a.id) AS agent_id, u.customer_id, card.card_token
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN agents a ON a.external_id = u.external_id
       LEFT JOIN LATERAL (
         SELECT ca.card_token FROM cards ca WHERE ca.customer_id = u.customer_id
         ORDER BY (ca.card_token = 'CARD-1001') DESC, ca.created_at, ca.card_token LIMIT 1
       ) card ON true
       WHERE u.id = $1 AND u.status = 'active'`,
      [request.auth.userId],
    );
    if (!result.rowCount) throw Object.assign(new Error('User not found'), { status: 404, code: 'UNAUTHORIZED' });
    const user = result.rows[0];
    return {
      user: {
        id: user.id,
        externalId: user.external_id,
        role: user.role,
        agentId: user.agent_id ?? null,
        cardToken: user.card_token ?? null,
        operatorId: user.operator_id ?? null,
      },
    };
  }

  @Get('cards/:token/balance')
  async cardBalance(@Param('token') token: string, @Req() request: MobileRequest) {
    const card = await this.findAccessibleCard(token, request.auth);
    const result = await database.query(
      `SELECT COALESCE(SUM(le.credit_minor - le.debit_minor), 0)::bigint AS balance
       FROM accounts ac JOIN ledger_entries le ON le.account_id = ac.id
       WHERE ac.code = 'CUSTOMER_WALLET' AND ac.customer_id = $1`,
      [card.customer_id],
    );
    return {
      cardToken: card.card_token,
      maskedCardNumber: `•••• ${card.card_token.slice(-4)}`,
      status: card.status,
      balanceMinor: asMinor(result.rows[0].balance),
      offlineAllowanceMinor: asMinor(card.offline_allowance_minor),
      lastSyncedAt: (card.last_synced_at ?? card.created_at).toISOString(),
      tier: card.tier,
      lastTapCounter: Number(card.counter),
    };
  }

  @Get('cards/:token/activity')
  async cardActivity(
    @Param('token') token: string,
    @Query('page') pageValue: string | undefined,
    @Query('pageSize') pageSizeValue: string | undefined,
    @Query('filter') filter = 'all',
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: MobileRequest,
  ) {
    const card = await this.findAccessibleCard(token, request.auth);
    if (!['all', 'trips', 'topups'].includes(filter)) {
      throw Object.assign(new Error('filter must be all, trips, or topups'), { status: 400, code: 'INVALID_FILTER' });
    }
    if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))) {
      throw Object.assign(new Error('from and to must be valid ISO timestamps'), { status: 400, code: 'INVALID_DATE_RANGE' });
    }
    const paging = pagination(pageValue, pageSizeValue);
    const base = `
      SELECT * FROM (
        SELECT t.id, t.posted_transaction_id AS transaction_id, 'trip'::text AS type,
               COALESCE(r.name, 'Transit trip') AS title, COALESCE(tm.name, 'Terminal') AS detail,
               r.name AS route_name, tm.name AS terminal_id, c.card_token,
               -COALESCE(t.settled_fare_minor, t.claimed_fare_minor)::bigint AS amount_minor,
               COALESCE(t.settled_fare_minor, t.claimed_fare_minor)::bigint AS fare_settled_minor,
               CASE WHEN t.status = 'posted' THEN 'confirmed' ELSE 'pending' END AS status,
               CASE WHEN t.offline_flag THEN 'pending' ELSE 'synced' END AS sync_status,
               t.offline_flag AS offline, t.tapped_at AS occurred_at, t.created_at
        FROM taps t JOIN cards c ON c.id = t.card_id
        LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN terminals tm ON tm.id = t.terminal_id
        WHERE c.id = $1
        UNION ALL
        SELECT fr.id, fr.transaction_id, 'topup'::text AS type, 'Card top-up' AS title,
               'Agent top-up' AS detail, NULL::text AS route_name, NULL::text AS terminal_id,
               c.card_token, fr.amount_minor::bigint AS amount_minor, NULL::bigint AS fare_settled_minor,
               fr.status, CASE WHEN fr.status = 'confirmed' THEN 'synced' ELSE 'pending' END AS sync_status,
               false AS offline, COALESCE(fr.confirmed_at, fr.created_at) AS occurred_at, fr.created_at
        FROM funding_requests fr JOIN cards c ON c.id = fr.card_id WHERE c.id = $1
      ) activity
      WHERE ($2 = 'all' OR ($2 = 'trips' AND type = 'trip') OR ($2 = 'topups' AND type = 'topup'))
        AND ($3::timestamptz IS NULL OR occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR occurred_at <= $4)`;
    const params = [card.id, filter, from ?? null, to ?? null];
    const [count, rows] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS total FROM (${base}) rows`, params),
      database.query(`${base} ORDER BY occurred_at DESC, id LIMIT $5 OFFSET $6`, [
        ...params, paging.pageSize, paging.offset,
      ]),
    ]);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        type: row.type,
        title: row.title,
        detail: row.detail,
        routeName: row.route_name,
        terminalId: row.terminal_id,
        cardToken: row.card_token,
        amountMinor: asMinor(row.amount_minor),
        fareSettledMinor: row.fare_settled_minor === null ? null : asMinor(row.fare_settled_minor),
        status: row.status,
        syncStatus: row.sync_status,
        offline: row.offline,
        occurredAt: row.occurred_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      })),
      total: count.rows[0].total,
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  async blockCard(
    @Param('token') token: string,
    @Body() body: { reason?: string; stepUpToken?: string },
    @Headers('x-request-id') requestId: string | undefined,
    @Req() request: MobileRequest,
  ) {
    if (request.auth.role !== 'customer' &&
        !['platform_admin', 'platform_support', 'operator_admin'].includes(request.auth.role)) {
      throw Object.assign(new Error('Card management is not allowed'), { status: 403, code: 'FORBIDDEN' });
    }
    if (!['lost', 'stolen', 'other'].includes(body.reason ?? '')) {
      throw Object.assign(new Error('reason must be lost, stolen, or other'), { status: 400, code: 'INVALID_REASON' });
    }
    if (body.stepUpToken && !verifyRecentCustomerStepUp(body.stepUpToken, request.auth.userId)) {
      throw Object.assign(new Error('Invalid or expired step-up token'), { status: 401, code: 'UNAUTHORIZED' });
    }
    const card = await this.findAccessibleCard(token, request.auth);
    const event = await this.setCardStatus(card, 'blocked', body.reason!, request.auth, requestId);
    return {
      cardToken: card.card_token,
      status: 'blocked',
      blockedAt: event.created_at.toISOString(),
      effectiveOnline: true,
      effectiveOffline: false,
    };
  }

  async unblockCard(
    @Param('token') token: string,
    @Body() body: { reason?: string; stepUpToken?: string },
    @Headers('x-request-id') requestId: string | undefined,
    @Req() request: MobileRequest,
  ) {
    if (request.auth.role !== 'customer') {
      throw Object.assign(new Error('Only the card owner can unblock this card'), { status: 403, code: 'FORBIDDEN' });
    }
    if (body.reason !== 'customer_requested' || !body.stepUpToken ||
        !verifyRecentCustomerStepUp(body.stepUpToken, request.auth.userId)) {
      throw Object.assign(new Error('A valid OTP step-up token and customer_requested reason are required'), { status: 401, code: 'UNAUTHORIZED' });
    }
    const card = await this.findAccessibleCard(token, request.auth);
    const event = await this.setCardStatus(card, 'active', body.reason, request.auth, requestId);
    return { cardToken: card.card_token, status: 'active', unblockedAt: event.created_at.toISOString() };
  }

  @Get('agents/:id/summary')
  async agentSummary(@Param('id') id: string, @Req() request: MobileRequest) {
    await this.assertAgentAccess(id, request.auth);
    const result = await database.query(
      `SELECT a.id, a.name, a.external_id, a.status, a.opening_float_minor,
         COALESCE((SELECT SUM(le.credit_minor - le.debit_minor) FROM ledger_entries le
           WHERE le.account_id = a.float_account_id), 0)::bigint AS remaining_minor,
         COALESCE((SELECT SUM(fr.amount_minor) FROM funding_requests fr
           WHERE fr.agent_id = a.id AND fr.status = 'confirmed'
             AND (fr.confirmed_at AT TIME ZONE 'Africa/Blantyre')::date =
                 (now() AT TIME ZONE 'Africa/Blantyre')::date), 0)::bigint AS cash_topups_issued_minor,
         COALESCE(ds.cash_taken_minor, (
           SELECT SUM(fr.amount_minor) FROM funding_requests fr
           WHERE fr.agent_id = a.id AND fr.status = 'confirmed'
             AND (fr.confirmed_at AT TIME ZONE 'Africa/Blantyre')::date =
                 (now() AT TIME ZONE 'Africa/Blantyre')::date
         ), 0)::bigint AS cash_taken_minor,
         COALESCE(ds.topup_count, (
           SELECT COUNT(*) FROM funding_requests fr
           WHERE fr.agent_id = a.id AND fr.status = 'confirmed'
             AND (fr.confirmed_at AT TIME ZONE 'Africa/Blantyre')::date =
                 (now() AT TIME ZONE 'Africa/Blantyre')::date
         ), 0)::int AS topup_count,
         COALESCE(ds.commission_minor, (
           SELECT SUM(fr.commission_minor) FROM funding_requests fr
           WHERE fr.agent_id = a.id AND fr.status = 'confirmed'
             AND (fr.confirmed_at AT TIME ZONE 'Africa/Blantyre')::date =
                 (now() AT TIME ZONE 'Africa/Blantyre')::date
         ), 0)::bigint AS commission_today_minor
       FROM agents a LEFT JOIN agent_daily_stats ds
         ON ds.agent_id = a.id AND ds.business_day = (now() AT TIME ZONE 'Africa/Blantyre')::date
       WHERE a.id = $1`,
      [id],
    );
    if (!result.rowCount) throw Object.assign(new Error('Agent not found'), { status: 404, code: 'AGENT_NOT_FOUND' });
    const agent = result.rows[0];
    const loads = await database.query(
      `SELECT fr.id, fr.transaction_id, c.card_token, fr.amount_minor, fr.commission_minor,
              fr.status, COALESCE(fr.confirmed_at, fr.created_at) AS occurred_at
       FROM funding_requests fr LEFT JOIN cards c ON c.id = fr.card_id
       WHERE fr.agent_id = $1 ORDER BY fr.created_at DESC LIMIT 5`,
      [id],
    );
    const issued = asMinor(agent.cash_topups_issued_minor);
    return {
      agent: { id: agent.id, name: agent.name, externalId: agent.external_id, status: agent.status },
      float: {
        openingMinor: asMinor(agent.opening_float_minor),
        cashTopupsIssuedMinor: issued,
        remainingMinor: asMinor(agent.remaining_minor),
        commissionAccruedTodayMinor: asMinor(agent.commission_today_minor),
      },
      today: {
        cashTakenMinor: asMinor(agent.cash_taken_minor),
        topupCount: Number(agent.topup_count),
        commissionMinor: asMinor(agent.commission_today_minor),
      },
      recentLoads: loads.rows.map((load) => this.loadResult(load)),
    };
  }

  @Get('agents/:id/loads')
  async agentLoads(
    @Param('id') id: string,
    @Query('page') pageValue: string | undefined,
    @Query('pageSize') pageSizeValue: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('status') status: string | undefined,
    @Req() request: MobileRequest,
  ) {
    await this.assertAgentAccess(id, request.auth);
    if (status && !['confirmed', 'pending', 'failed'].includes(status)) {
      throw Object.assign(new Error('status must be confirmed, pending, or failed'), { status: 400, code: 'INVALID_FILTER' });
    }
    const paging = pagination(pageValue, pageSizeValue);
    const filters = [id, from ?? null, to ?? null, status ?? null];
    const where = `WHERE fr.agent_id = $1 AND ($2::timestamptz IS NULL OR fr.created_at >= $2)
      AND ($3::timestamptz IS NULL OR fr.created_at <= $3) AND ($4::text IS NULL OR fr.status = $4)`;
    const [count, rows] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS total FROM funding_requests fr ${where}`, filters),
      database.query(
        `SELECT fr.id, fr.transaction_id, c.card_token, fr.amount_minor, fr.commission_minor,
                fr.status, COALESCE(fr.confirmed_at, fr.created_at) AS occurred_at
         FROM funding_requests fr LEFT JOIN cards c ON c.id = fr.card_id ${where}
         ORDER BY fr.created_at DESC LIMIT $5 OFFSET $6`,
        [...filters, paging.pageSize, paging.offset],
      ),
    ]);
    return {
      items: rows.rows.map((row) => this.loadResult(row)),
      total: count.rows[0].total,
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  @Get('ledger/entries')
  async ledgerEntries(
    @Query('accountId') accountId: string | undefined,
    @Query('agentId') agentId: string | undefined,
    @Query('cardToken') cardToken: string | undefined,
    @Query('type') type: string | undefined,
    @Query('page') pageValue: string | undefined,
    @Query('pageSize') pageSizeValue: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: MobileRequest,
  ) {
    if (type && !['credit', 'debit', 'commission', 'float'].includes(type)) {
      throw Object.assign(new Error('Unknown ledger type'), { status: 400, code: 'INVALID_FILTER' });
    }
    const paging = pagination(pageValue, pageSizeValue);
    const scopedAgentId = request.auth.role === 'agent' ? request.auth.agentId : agentId ?? null;
    if (request.auth.role === 'agent' && agentId && agentId !== request.auth.agentId) {
      throw Object.assign(new Error('Agent access denied'), { status: 403, code: 'FORBIDDEN' });
    }
    const scopedCardToken = cardToken ?? null;
    const values = [
      accountId ?? null, scopedAgentId, scopedCardToken, type ?? null, from ?? null, to ?? null,
      request.auth.role, request.auth.userId, request.auth.operatorId,
    ];
    const where = `WHERE ($1::uuid IS NULL OR ac.id = $1)
      AND ($2::uuid IS NULL OR ac.agent_id = $2)
      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM cards ca WHERE ca.customer_id = ac.customer_id AND ca.card_token = $3))
      AND ($4::text IS NULL OR CASE
        WHEN ac.code IN ('COMMISSION_EXPENSE', 'COMMISSION_PAYABLE') THEN 'commission'
        WHEN ac.account_type = 'agent_float' THEN 'float'
        WHEN le.debit_minor > 0 THEN 'debit' ELSE 'credit' END = $4)
      AND ($5::timestamptz IS NULL OR le.created_at >= $5)
      AND ($6::timestamptz IS NULL OR le.created_at <= $6)
      AND ($7 <> 'customer' OR ac.customer_id = (SELECT customer_id FROM users WHERE id = $8))
      AND ($7 IN ('platform_admin', 'platform_finance', 'platform_support', 'auditor', 'customer')
           OR ac.operator_id = $9)
      AND ($7 <> 'agent' OR ac.agent_id = $2 OR
           (t.event_type = 'agent_topup' AND EXISTS (
             SELECT 1 FROM funding_requests fr WHERE fr.transaction_id = t.id AND fr.agent_id = $2)))`;
    const [count, rows] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS total FROM ledger_entries le JOIN accounts ac ON ac.id = le.account_id JOIN transactions t ON t.id = le.transaction_id ${where}`, values),
      database.query(
        `SELECT le.id, le.transaction_id, ac.id AS account_id, ac.agent_id, ac.customer_id,
                t.event_type, t.description, le.debit_minor, le.credit_minor, le.created_at,
                ac.code AS account_code,
                (SELECT SUM(le2.credit_minor - le2.debit_minor) FROM ledger_entries le2
                 WHERE le2.account_id = ac.id AND (le2.created_at, le2.id) <= (le.created_at, le.id))::bigint AS balance_after,
                COALESCE(
                  (SELECT ca.card_token FROM cards ca WHERE ca.customer_id = ac.customer_id
                   ORDER BY ca.created_at, ca.card_token LIMIT 1),
                  (SELECT ca.card_token FROM funding_requests fr JOIN cards ca ON ca.id = fr.card_id
                   WHERE fr.transaction_id = t.id LIMIT 1)
                ) AS card_token,
                COALESCE(ac.agent_id, (SELECT fr.agent_id FROM funding_requests fr
                  WHERE fr.transaction_id = t.id LIMIT 1)) AS ledger_agent_id
         FROM ledger_entries le JOIN accounts ac ON ac.id = le.account_id
         JOIN transactions t ON t.id = le.transaction_id ${where}
         ORDER BY le.created_at DESC, le.id DESC LIMIT $10 OFFSET $11`,
        [...values, paging.pageSize, paging.offset],
      ),
    ]);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        accountId: row.account_id,
        agentId: row.ledger_agent_id,
        cardToken: row.card_token,
        type: row.account_code === 'AGENT_FLOAT' ? 'float' : ['COMMISSION_EXPENSE', 'COMMISSION_PAYABLE'].includes(row.account_code) ? 'commission' : Number(row.debit_minor) > 0 ? 'debit' : 'credit',
        amountMinor: asMinor(row.debit_minor || row.credit_minor),
        balanceAfterMinor: asMinor(row.balance_after),
        status: 'confirmed',
        description: row.description ?? row.event_type,
        occurredAt: row.created_at.toISOString(),
      })),
      total: count.rows[0].total,
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  private async findAccessibleCard(token: string, auth: AuthContext) {
    const result = await database.query(
      `SELECT c.id, c.card_token, c.status, c.tier, c.offline_allowance_minor,
              c.counter, c.last_synced_at, c.created_at, c.customer_id, c.operator_id
       FROM cards c
       WHERE c.card_token = $1
         AND ($2 <> 'customer' OR EXISTS (
           SELECT 1 FROM users u WHERE u.id = $3 AND u.customer_id = c.customer_id))
         AND ($2 <> 'agent' OR c.operator_id = $4)
         AND ($2 IN ('platform_admin', 'platform_finance', 'platform_support', 'auditor', 'customer')
              OR c.operator_id = $4)`,
      [token, auth.role, auth.userId, auth.operatorId],
    );
    if (!result.rowCount) throw Object.assign(new Error('Card not found'), { status: 404, code: 'CARD_NOT_FOUND' });
    return result.rows[0] as {
      id: string;
      card_token: string;
      status: string;
      tier: string;
      offline_allowance_minor: string;
      counter: number;
      last_synced_at: Date | null;
      created_at: Date;
      customer_id: string;
      operator_id: string;
    };
  }

  private async assertAgentAccess(agentId: string, auth: AuthContext) {
    if (auth.role === 'agent' && auth.agentId !== agentId) {
      throw Object.assign(new Error('Agent access denied'), { status: 403, code: 'FORBIDDEN' });
    }
    if (auth.role === 'customer') {
      throw Object.assign(new Error('Agent access denied'), { status: 403, code: 'FORBIDDEN' });
    }
    if (!['platform_admin', 'platform_finance', 'platform_support', 'auditor'].includes(auth.role)) {
      const owner = await database.query('SELECT 1 FROM agents WHERE id = $1 AND operator_id = $2', [agentId, auth.operatorId]);
      if (!owner.rowCount) throw Object.assign(new Error('Agent not found'), { status: 404, code: 'AGENT_NOT_FOUND' });
    }
  }

  private loadResult(row: Record<string, unknown>) {
    return {
      id: row.id,
      fundingRequestId: row.id,
      transactionId: row.transaction_id,
      cardToken: row.card_token,
      amountMinor: asMinor(row.amount_minor as string),
      commissionMinor: asMinor(row.commission_minor as string),
      status: row.status,
      occurredAt: (row.occurred_at as Date).toISOString(),
    };
  }

  private async setCardStatus(
    card: { id: string; card_token: string; operator_id: string },
    status: 'active' | 'blocked',
    reason: string,
    auth: AuthContext,
    requestId?: string,
  ) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`card-status:${card.operator_id}`]);
      await client.query('UPDATE cards SET status = $1 WHERE id = $2', [status, card.id]);
      const version = await client.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM blacklist_events WHERE operator_id = $1',
        [card.operator_id],
      );
      const event = await client.query(
        `INSERT INTO blacklist_events(operator_id, card_id, version, action, reason)
         VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
        [card.operator_id, card.id, version.rows[0].version, status === 'blocked' ? 'block' : 'unblock', reason],
      );
      await client.query('UPDATE terminals SET blocked_list_version = $1 WHERE operator_id = $2', [version.rows[0].version, card.operator_id]);
      await client.query(
        `INSERT INTO audit_log(actor_id, actor_role, operator_id, action, reason, request_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.userId, auth.role, card.operator_id, status === 'blocked' ? 'card_block' : 'card_unblock', reason, requestId ?? null],
      );
      await client.query('COMMIT');
      return event.rows[0] as { created_at: Date };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

@Controller('v1')
export class MobilePublicController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    await database.query('SELECT 1');
    return { status: 'ready' };
  }

  @Get('app/config')
  appConfig() {
    return {
      mode: process.env.NODE_ENV === 'production' ? 'production' : 'pilot',
      currency: 'MWK',
      minorUnitName: 'tambala',
      offlineTapAllowanceMinor: 300000,
      demoAccounts: [
        { role: 'customer', phone: '+265888100200' },
        { role: 'agent', phone: '+265999111222' },
      ],
    };
  }
}

@Controller('v1/agents')
@UseGuards(AuthGuard)
export class MobileAgentListController {
  @Get()
  async list(
    @Query('operatorId') requestedOperatorId: string,
    @Query('status') status: string | undefined,
    @Query('page') pageValue: string | undefined,
    @Query('pageSize') pageSizeValue: string | undefined,
    @Req() request: MobileRequest,
  ) {
    if (status && !['active', 'blocked', 'inactive'].includes(status)) {
      throw Object.assign(new Error('Unknown agent status'), { status: 400, code: 'INVALID_FILTER' });
    }
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const paging = pagination(pageValue, pageSizeValue);
    const filters = [operatorId, status ?? null];
    const where = 'WHERE a.operator_id = $1 AND ($2::text IS NULL OR a.status = $2)';
    const [count, rows] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS total FROM agents a ${where}`, filters),
      database.query(
        `SELECT a.id, a.name, a.external_id AS phone, a.location, a.status,
          COALESCE((SELECT SUM(le.credit_minor - le.debit_minor) FROM ledger_entries le
            WHERE le.account_id = a.float_account_id), 0)::bigint AS float_minor
         FROM agents a ${where} ORDER BY a.name LIMIT $3 OFFSET $4`,
        [...filters, paging.pageSize, paging.offset],
      ),
    ]);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        phone: row.phone,
        location: row.location,
        floatMinor: asMinor(row.float_minor),
        status: row.status,
      })),
      total: count.rows[0].total,
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }
}

@Controller('v1')
@UseGuards(AuthGuard)
export class MobileCardListController {
  @Get('cards')
  async listCards(
    @Query('operatorId') requestedOperatorId: string,
    @Query('status') status: string | undefined,
    @Query('page') pageValue: string | undefined,
    @Query('pageSize') pageSizeValue: string | undefined,
    @Req() request: MobileRequest,
  ) {
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    if (status && !['active', 'blocked'].includes(status)) {
      throw Object.assign(new Error('status must be active or blocked'), { status: 400, code: 'INVALID_FILTER' });
    }
    const paging = pagination(pageValue, pageSizeValue);
    const filters = [operatorId, status ?? null];
    const where = 'WHERE c.operator_id = $1 AND ($2::text IS NULL OR c.status = $2)';
    const [count, rows] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS total FROM cards c ${where}`, filters),
      database.query(
        `SELECT c.id, c.card_token, c.status, c.tier, c.offline_allowance_minor,
           COALESCE((SELECT SUM(le.credit_minor - le.debit_minor) FROM accounts ac
             JOIN ledger_entries le ON le.account_id = ac.id
             WHERE ac.customer_id = c.customer_id AND ac.code = 'CUSTOMER_WALLET'), 0)::bigint AS balance_minor
         FROM cards c ${where} ORDER BY c.card_token LIMIT $3 OFFSET $4`,
        [...filters, paging.pageSize, paging.offset],
      ),
    ]);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        cardToken: row.card_token,
        maskedCardNumber: `•••• ${String(row.card_token).slice(-4)}`,
        status: row.status,
        balanceMinor: asMinor(row.balance_minor),
        offlineAllowanceMinor: asMinor(row.offline_allowance_minor),
        tier: row.tier,
      })),
      total: count.rows[0].total,
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }
}