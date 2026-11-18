import { Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { database } from '../../database.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Roles } from '../auth/auth.decorator.js';
import { AuthContext } from '../auth/auth.types.js';
import { resolveOperatorId } from '../auth/tenant.js';

@Controller('v1')
@UseGuards(AuthGuard)
export class AdminController {
  @Get('cards')
  @Roles('platform_admin', 'platform_support', 'operator_admin', 'operator_finance', 'auditor')
  async cards(
    @Req() request: { auth: AuthContext },
    @Query('operatorId') requestedOperatorId: string,
    @Query('cursor') cursor?: string,
  ) {
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const result = await database.query(
      `SELECT id, card_token, status, tier, offline_allowance_minor
       FROM cards WHERE operator_id = $1
       AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id LIMIT 51`,
      [operatorId, cursor ?? null],
    );
    const hasNext = result.rows.length > 50;
    const rows = result.rows.slice(0, 50);
    return {
      items: rows,
      nextCursor: hasNext ? rows[rows.length - 1].id : null,
    };
  }

  @Post('cards/:id/block')
  @Roles('platform_admin', 'platform_support', 'operator_admin')
  async block(
    @Param('id') id: string,
    @Headers('x-request-id') requestId: string | undefined,
    @Query('operatorId') requestedOperatorId: string,
    @Req() request: { auth: AuthContext },
  ) {
    const operatorId = resolveOperatorId(request.auth, requestedOperatorId);
    const result = await database.query(
      `UPDATE cards SET status = 'blocked'
       WHERE id = $1 AND operator_id = $2 RETURNING id, status`,
      [id, operatorId],
    );
    if (!result.rowCount) throw Object.assign(new Error('Card not found'), { status: 404, code: 'CARD_NOT_FOUND' });
    await database.query(
      `INSERT INTO blacklist_events(operator_id, card_id, version, action, reason)
       VALUES ($1, $2,
         COALESCE((SELECT MAX(version) FROM blacklist_events WHERE card_id = $2), 0) + 1,
         'block', 'support request')`,
      [operatorId, id],
    );
    await database.query(
      `INSERT INTO audit_log(actor_id, operator_id, action, reason, request_id)
       VALUES ($1, $2, 'card_block', 'lost or compromised card', $3)`,
      [request.auth.userId, operatorId, requestId ?? null],
    );
    return result.rows[0];
  }
}
