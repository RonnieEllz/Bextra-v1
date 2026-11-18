import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { database } from '../../database.js';

@Controller('v1/terminals')
export class DevicesController {
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
  async config(@Query('terminalId') terminalId: string) {
    const terminal = await database.query(
      'SELECT blocked_list_version FROM terminals WHERE id = $1',
      [terminalId],
    );
    if (!terminal.rowCount) throw Object.assign(new Error('Terminal not found'), { status: 404, code: 'TERMINAL_NOT_FOUND' });
    const events = await database.query(
      `SELECT card_id, version, action, reason FROM blacklist_events
       WHERE operator_id = (SELECT operator_id FROM terminals WHERE id = $1)
       AND version > COALESCE($2, 0) ORDER BY version ASC`,
      [terminalId, Number(0)],
    );
    return { blockedListVersion: terminal.rows[0].blocked_list_version, events: events.rows };
  }
}
