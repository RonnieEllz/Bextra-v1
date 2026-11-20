import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { database } from '../../database.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Roles } from '../auth/auth.decorator.js';
import { AuthContext } from '../auth/auth.types.js';
import { resolveOperatorId } from '../auth/tenant.js';
import { MobileController } from '../mobile/mobile.controller.js';

@Controller('v1')
@UseGuards(AuthGuard)
export class AdminController {
  @Get('operators')
  @Roles('platform_admin', 'platform_finance', 'platform_support', 'auditor')
  async operators(@Query('cursor') cursor?: string) {
    const result = await database.query(
      `SELECT id, name, status, created_at FROM operators
       WHERE ($1::uuid IS NULL OR id > $1::uuid)
       ORDER BY id LIMIT 51`,
      [cursor ?? null],
    );
    const hasNext = result.rows.length > 50;
    const rows = result.rows.slice(0, 50);
    return { items: rows, nextCursor: hasNext ? rows[rows.length - 1].id : null };
  }

  @Get('agents')
  @Roles('platform_admin', 'platform_finance', 'platform_support', 'operator_admin', 'operator_finance', 'agent', 'auditor')
  async agents(
    @Req() request: { auth: AuthContext },
    @Query('operatorId') requestedOperatorId: string,
    @Query('status') status?: string,
    @Query('page') pageValue?: string,
    @Query('pageSize') pageSizeValue?: string,
  ) {
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const page = pageValue === undefined ? 1 : Number(pageValue);
    const pageSize = pageSizeValue === undefined ? 20 : Number(pageSizeValue);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw Object.assign(new Error('Invalid pagination'), { status: 400, code: 'INVALID_PAGINATION' });
    }
    if (status && !['active', 'blocked', 'inactive'].includes(status)) {
      throw Object.assign(new Error('Unknown agent status'), { status: 400, code: 'INVALID_FILTER' });
    }
    const filters = [operatorId, status ?? null, request.auth.role === 'agent' ? request.auth.agentId ?? null : null];
    const where = `WHERE a.operator_id = $1 AND ($2::text IS NULL OR a.status = $2)
       AND ($3::uuid IS NULL OR a.id = $3)`;
    const [count, result] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS total FROM agents a ${where}`, filters),
      database.query(
        `SELECT a.id, a.name, a.status, a.commission_bps, a.external_id AS phone, a.location,
                (a.invitation_token_hash IS NOT NULL AND a.invitation_expires_at > now()) AS invitation_pending,
                a.invitation_expires_at,
                COALESCE((
                  SELECT SUM(le.credit_minor - le.debit_minor)
                  FROM ledger_entries le
                  WHERE le.account_id = a.float_account_id
                ), 0)::bigint AS float_minor
         FROM agents a ${where}
         ORDER BY a.name LIMIT $4 OFFSET $5`,
        [...filters, pageSize, (page - 1) * pageSize],
      ),
    ]);
    return {
      items: result.rows.map((row) => ({
        ...row,
        phone: row.phone,
        floatMinor: Number(row.float_minor),
        invitationPending: row.invitation_pending,
        invitationExpiresAt: row.invitation_expires_at,
      })),
      total: count.rows[0].total,
      page,
      pageSize,
    };
  }

  @Post('agents')
  @Roles('platform_admin', 'operator_admin')
  async createAgent(
    @Body() body: { operatorId?: string; name?: string; phone?: string; location?: string; commissionBps?: number } | undefined,
    @Req() request: { auth: AuthContext },
    @Headers('x-request-id') requestId?: string,
  ) {
    const input = body ?? {};
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
    const location = typeof input.location === 'string' ? input.location.trim() || null : null;
    const commissionBps = input.commissionBps ?? 100;
    if (!name || name.length > 120 || !phone || !/^\+[1-9]\d{7,14}$/.test(phone) ||
        (input.location !== undefined && typeof input.location !== 'string') ||
        (typeof input.location === 'string' && input.location.trim().length > 200) ||
        !Number.isSafeInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
      throw Object.assign(new Error('Provide a name, international phone number, optional location, and a valid commission rate'), { status: 400, code: 'INVALID_AGENT_DETAILS' });
    }
    const operatorId = resolveOperatorId(request.auth, input.operatorId);
    const setupToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(setupToken).digest('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const operator = await client.query(
        `SELECT id FROM operators WHERE id = $1 AND status = 'active'`,
        [operatorId],
      );
      if (!operator.rowCount) {
        throw Object.assign(new Error('Operator not found or inactive'), { status: 404, code: 'OPERATOR_NOT_FOUND' });
      }
      const existing = await client.query(
        `SELECT 1 FROM users WHERE external_id = $1
         UNION ALL SELECT 1 FROM agents WHERE external_id = $1`,
        [phone],
      );
      if (existing.rowCount) {
        throw Object.assign(new Error('An account already uses this phone number'), { status: 409, code: 'PHONE_ALREADY_REGISTERED' });
      }
      const agent = await client.query(
        `INSERT INTO agents(operator_id, name, external_id, location, commission_bps,
                            opening_float_minor, status, invitation_token_hash, invitation_expires_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'inactive', $6, $7)
         RETURNING id, name, external_id, location, status, commission_bps`,
        [operatorId, name, phone, location, commissionBps, tokenHash, expiresAt],
      );
      const agentId = agent.rows[0].id as string;
      const floatAccount = await client.query(
        `INSERT INTO accounts(operator_id, code, name, account_type, agent_id)
         VALUES ($1, $2, $3, 'agent_float', $4) RETURNING id`,
        [operatorId, `AGENT_FLOAT_${agentId.replaceAll('-', '')}`, `${name} Float`, agentId],
      );
      await client.query(
        `UPDATE agents SET float_account_id = $1 WHERE id = $2`,
        [floatAccount.rows[0].id, agentId],
      );
      const user = await client.query(
        `INSERT INTO users(operator_id, role_id, external_id, status, agent_id)
         SELECT $1, id, $2, 'inactive', $3 FROM roles WHERE name = 'agent'
         RETURNING id`,
        [operatorId, phone, agentId],
      );
      if (!user.rowCount) throw new Error('Agent role is not configured');
      await client.query(
        `INSERT INTO audit_log(actor_id, actor_role, operator_id, action, request_id, details)
         VALUES ($1, $2, $3, 'agent_invited', $4, $5::jsonb)`,
        [request.auth.userId, request.auth.role, operatorId, requestId ?? null,
          JSON.stringify({ agentId, phone })],
      );
      await client.query('COMMIT');
      return {
        agent: { ...agent.rows[0], phone, invitationPending: true, invitationExpiresAt: expiresAt.toISOString() },
        setupToken,
        setupExpiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        throw Object.assign(new Error('An account already uses this phone number'), { status: 409, code: 'PHONE_ALREADY_REGISTERED' });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('agents/:id/invitation')
  @Roles('platform_admin', 'operator_admin')
  async reissueAgentInvitation(
    @Param('id') id: string,
    @Query('operatorId') requestedOperatorId: string,
    @Req() request: { auth: AuthContext },
    @Headers('x-request-id') requestId?: string,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw Object.assign(new Error('Invalid agent ID'), { status: 400, code: 'INVALID_AGENT_ID' });
    }
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const setupToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(setupToken).digest('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const agent = await client.query(
        `SELECT a.id, a.external_id, u.id AS user_id
         FROM agents a JOIN users u ON u.agent_id = a.id
         WHERE a.id = $1 AND a.operator_id = $2
         FOR UPDATE OF a, u`,
        [id, operatorId],
      );
      if (!agent.rowCount) {
        throw Object.assign(new Error('Agent not found'), { status: 404, code: 'AGENT_NOT_FOUND' });
      }
      await client.query(
        `UPDATE agents SET status = 'inactive', pin_hash = NULL,
           invitation_token_hash = $1, invitation_expires_at = $2
         WHERE id = $3`,
        [tokenHash, expiresAt, id],
      );
      await client.query(
        `UPDATE users SET status = 'inactive', password_hash = NULL,
           auth_version = auth_version + 1
         WHERE id = $1`,
        [agent.rows[0].user_id],
      );
      await client.query(
        `INSERT INTO audit_log(actor_id, actor_role, operator_id, action, request_id, details)
         VALUES ($1, $2, $3, 'agent_invitation_reissued', $4, $5::jsonb)`,
        [request.auth.userId, request.auth.role, operatorId, requestId ?? null,
          JSON.stringify({ agentId: id, phone: agent.rows[0].external_id })],
      );
      await client.query('COMMIT');
      return { agentId: id, setupToken, setupExpiresAt: expiresAt.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('agents/:id/status')
  @Roles('platform_admin', 'operator_admin')
  async setAgentStatus(
    @Param('id') id: string,
    @Query('operatorId') requestedOperatorId: string,
    @Body() body: { status?: string; reason?: string } | undefined,
    @Req() request: { auth: AuthContext },
    @Headers('x-request-id') requestId?: string,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw Object.assign(new Error('Invalid agent ID'), { status: 400, code: 'INVALID_AGENT_ID' });
    }
    const nextStatus = body?.status;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!['active', 'inactive', 'blocked'].includes(nextStatus ?? '') || !reason) {
      throw Object.assign(new Error('A valid status and written reason are required'), { status: 400, code: 'INVALID_AGENT_STATUS' });
    }
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const agent = await client.query(
        `SELECT a.id, a.status, a.pin_hash, a.invitation_token_hash,
                u.id AS user_id, u.password_hash
         FROM agents a JOIN users u ON u.agent_id = a.id
         WHERE a.id = $1 AND a.operator_id = $2
         FOR UPDATE OF a, u`,
        [id, operatorId],
      );
      if (!agent.rowCount) {
        throw Object.assign(new Error('Agent not found'), { status: 404, code: 'AGENT_NOT_FOUND' });
      }
      if (nextStatus === 'active' &&
          (!agent.rows[0].password_hash || !agent.rows[0].pin_hash || agent.rows[0].invitation_token_hash)) {
        throw Object.assign(new Error('Agent must complete account setup before activation'), { status: 409, code: 'AGENT_SETUP_REQUIRED' });
      }
      await client.query(`UPDATE agents SET status = $1 WHERE id = $2`, [nextStatus, id]);
      await client.query(
        `UPDATE users SET status = $1,
           auth_version = auth_version + CASE WHEN $1 = 'active' THEN 0 ELSE 1 END
         WHERE id = $2`,
        [nextStatus === 'active' ? 'active' : 'inactive', agent.rows[0].user_id],
      );
      await client.query(
        `INSERT INTO audit_log(actor_id, actor_role, operator_id, action, reason, request_id, details)
         VALUES ($1, $2, $3, 'agent_status_changed', $4, $5, $6::jsonb)`,
        [request.auth.userId, request.auth.role, operatorId, reason, requestId ?? null,
          JSON.stringify({ agentId: id, previousStatus: agent.rows[0].status, status: nextStatus })],
      );
      await client.query('COMMIT');
      return { agentId: id, status: nextStatus };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Get('terminals')
  @Roles('platform_admin', 'platform_support', 'operator_admin', 'operator_fleet', 'auditor')
  async terminals(@Req() request: { auth: AuthContext }, @Query('operatorId') requestedOperatorId: string) {
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const result = await database.query(
      `SELECT id, name, status, last_heartbeat_at, offline_queue_count,
              blocked_list_version, key_reference
       FROM terminals
       WHERE operator_id = $1
       ORDER BY name`,
      [operatorId],
    );
    return { items: result.rows };
  }

  @Get('dashboard')
  @Roles('platform_admin', 'platform_finance', 'platform_support', 'operator_admin', 'operator_finance', 'operator_fleet', 'auditor')
  async dashboard(@Req() request: { auth: AuthContext }, @Query('operatorId') requestedOperatorId: string) {
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const [cards, taps, terminals, settlements, risk] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS count FROM cards WHERE operator_id = $1`, [operatorId]),
      database.query(`SELECT COUNT(*)::int AS count FROM taps WHERE operator_id = $1 AND status = 'posted'`, [operatorId]),
      database.query(`SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE offline_queue_count > 0)::int AS queued FROM terminals WHERE operator_id = $1`, [operatorId]),
      database.query(`SELECT COUNT(*)::int AS count FROM settlements WHERE operator_id = $1 AND status = 'locked'`, [operatorId]),
      database.query(`SELECT COUNT(*)::int AS count FROM risk_events WHERE operator_id = $1`, [operatorId]),
    ]);
    return {
      cardCount: cards.rows[0].count,
      postedTapCount: taps.rows[0].count,
      terminalCount: terminals.rows[0].count,
      queuedTerminalCount: terminals.rows[0].queued,
      lockedSettlementCount: settlements.rows[0].count,
      riskEventCount: risk.rows[0].count,
    };
  }

  @Get('cards')
  @Roles('platform_admin', 'platform_support', 'operator_admin', 'operator_finance', 'agent', 'auditor', 'customer')
  async cards(
    @Req() request: { auth: AuthContext },
    @Query('operatorId') requestedOperatorId: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('page') pageValue?: string,
    @Query('pageSize') pageSizeValue?: string,
  ) {
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const page = pageValue === undefined ? 1 : Number(pageValue);
    const pageSize = pageSizeValue === undefined ? 20 : Number(pageSizeValue);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw Object.assign(new Error('Invalid pagination'), { status: 400, code: 'INVALID_PAGINATION' });
    }
    if (status && !['active', 'blocked'].includes(status)) {
      throw Object.assign(new Error('status must be active or blocked'), { status: 400, code: 'INVALID_FILTER' });
    }
    const customerOnly = request.auth.role === 'customer';
    const filters = [operatorId, cursor ?? null, status ?? null, customerOnly ? request.auth.userId : null];
    const where = `WHERE c.operator_id = $1
       AND ($2::uuid IS NULL OR c.id > $2::uuid)
       AND ($3::text IS NULL OR c.status = $3)
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = $4 AND u.customer_id = c.customer_id))`;
    const [count, result] = await Promise.all([
      database.query(`SELECT COUNT(*)::int AS total FROM cards c ${where}`, filters),
      database.query(
        `SELECT c.id, c.card_token, c.status, c.tier, c.offline_allowance_minor,
                COALESCE((SELECT SUM(le.credit_minor - le.debit_minor) FROM accounts ac
                  JOIN ledger_entries le ON le.account_id = ac.id
                  WHERE ac.customer_id = c.customer_id AND ac.code = 'CUSTOMER_WALLET'), 0)::bigint AS balance_minor
         FROM cards c ${where}
         ORDER BY c.id LIMIT $5 OFFSET $6`,
        [...filters, pageSize, (page - 1) * pageSize],
      ),
    ]);
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        card_token: row.card_token,
        cardToken: row.card_token,
        maskedCardNumber: `•••• ${String(row.card_token).slice(-4)}`,
        status: row.status,
        tier: row.tier,
        offline_allowance_minor: row.offline_allowance_minor,
        offlineAllowanceMinor: Number(row.offline_allowance_minor),
        balanceMinor: Number(row.balance_minor),
      })),
      total: count.rows[0].total,
      page,
      pageSize,
      nextCursor: result.rows.length === pageSize ? result.rows[result.rows.length - 1].id : null,
    };
  }

  @Post('cards/:id/block')
  @Roles('platform_admin', 'platform_support', 'operator_admin', 'customer')
  async block(
    @Param('id') id: string,
    @Headers('x-request-id') requestId: string | undefined,
    @Query('operatorId') requestedOperatorId: string,
    @Req() request: { auth: AuthContext },
    @Body() body: { reason?: string },
  ) {
    if (request.auth.role === 'customer') {
      return new MobileController().blockCard(id, body, requestId, { auth: request.auth });
    }
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    return this.setCardStatus(id, operatorId, 'blocked', request.auth.userId, requestId, body.reason ?? 'lost or compromised card');
  }

  @Post('cards/:id/unblock')
  @Roles('platform_admin', 'operator_admin', 'customer')
  async unblock(
    @Param('id') id: string,
    @Headers('x-request-id') requestId: string | undefined,
    @Query('operatorId') requestedOperatorId: string,
    @Req() request: { auth: AuthContext },
    @Body() body: { reason: string },
  ) {
    if (request.auth.role === 'customer') {
      return new MobileController().unblockCard(id, body, requestId, { auth: request.auth });
    }
    if (!body.reason?.trim()) {
      throw Object.assign(new Error('Written reason required'), { status: 400, code: 'REASON_REQUIRED' });
    }
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    return this.setCardStatus(id, operatorId, 'active', request.auth.userId, requestId, body.reason.trim());
  }

  private async setCardStatus(
    id: string,
    operatorId: string,
    status: 'active' | 'blocked',
    actorId: string,
    requestId: string | undefined,
    reason: string,
  ) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`card-status:${operatorId}`]);
      const card = await client.query(
        `UPDATE cards SET status = $1 WHERE id = $2 AND operator_id = $3 RETURNING id`,
        [status, id, operatorId],
      );
      if (!card.rowCount) {
        throw Object.assign(new Error('Card not found'), { status: 404, code: 'CARD_NOT_FOUND' });
      }
      const version = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM blacklist_events WHERE operator_id = $1`,
        [operatorId],
      );
      await client.query(
        `INSERT INTO blacklist_events(operator_id, card_id, version, action, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [operatorId, id, version.rows[0].version, status === 'blocked' ? 'block' : 'unblock', reason],
      );
      await client.query(
        `UPDATE terminals SET blocked_list_version = $1 WHERE operator_id = $2`,
        [version.rows[0].version, operatorId],
      );
      await client.query(
        `INSERT INTO audit_log(actor_id, operator_id, action, reason, request_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [actorId, operatorId, status === 'blocked' ? 'card_block' : 'card_unblock', reason, requestId ?? null],
      );
      await client.query('COMMIT');
      return { id, status, blockedListVersion: Number(version.rows[0].version) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
