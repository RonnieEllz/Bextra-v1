import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createPublicKey } from 'node:crypto';
import { database } from '../../database.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Roles } from '../auth/auth.decorator.js';
import { AuthContext } from '../auth/auth.types.js';
import { resolveOperatorId } from '../auth/tenant.js';

@Controller('v1/terminals')
export class DevicesController {
  @Post(':terminalId/key')
  @UseGuards(AuthGuard)
  @Roles('platform_admin', 'operator_admin')
  async registerKey(
    @Param('terminalId') terminalId: string,
    @Body() body: { publicKey: string; keyReference?: string },
    @Req() request: { auth: AuthContext },
  ) {
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey(body.publicKey);
    } catch {
      throw Object.assign(new Error('Invalid terminal public key'), { status: 400, code: 'INVALID_PUBLIC_KEY' });
    }
    if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw Object.assign(new Error('Terminal key must be RSA with at least 2048 bits'), { status: 400, code: 'INVALID_PUBLIC_KEY' });
    }
    const operatorId = request.auth.role === 'platform_admin'
      ? undefined
      : resolveOperatorId(request.auth);
    const result = await database.query(
      `UPDATE terminals
       SET public_key = $1, key_reference = COALESCE($2, key_reference)
       WHERE id = $3 AND ($4::uuid IS NULL OR operator_id = $4)
       RETURNING id, operator_id`,
      [publicKey.export({ type: 'spki', format: 'pem' }).toString(), body.keyReference ?? null, terminalId, operatorId ?? null],
    );
    if (!result.rowCount) throw Object.assign(new Error('Terminal not found'), { status: 404, code: 'TERMINAL_NOT_FOUND' });
    return { terminalId: result.rows[0].id, status: 'key_registered' };
  }

  @Post('heartbeat')
  async heartbeat(@Headers('x-request-id') requestId: string | undefined, @Body() body: Record<string, unknown>) {
    await database.query(
      `UPDATE terminals SET last_heartbeat_at = now(),
       offline_queue_count = COALESCE($2, offline_queue_count)
       WHERE id = $1`,
      [body.terminalId, body.offlineQueueCount],
    );
    return { status: 'accepted', requestId };
  }

  @Get('config')
  async config(@Query('terminalId') terminalId: string, @Query('sinceVersion') sinceVersion = '0') {
    const terminal = await database.query(
      'SELECT blocked_list_version FROM terminals WHERE id = $1',
      [terminalId],
    );
    if (!terminal.rowCount) throw Object.assign(new Error('Terminal not found'), { status: 404, code: 'TERMINAL_NOT_FOUND' });
    const events = await database.query(
      `SELECT card_id, version, action, reason FROM blacklist_events
       WHERE operator_id = (SELECT operator_id FROM terminals WHERE id = $1)
       AND version > $2 ORDER BY version ASC`,
       [terminalId, Number(sinceVersion)],
    );
    return { blockedListVersion: terminal.rows[0].blocked_list_version, events: events.rows };
  }
}
