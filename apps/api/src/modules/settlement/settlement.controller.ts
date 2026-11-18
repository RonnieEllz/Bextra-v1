import { Body, Controller, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SettlementService } from './settlement.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Roles } from '../auth/auth.decorator.js';
import { AuthContext } from '../auth/auth.types.js';
import { resolveOperatorId } from '../auth/tenant.js';

@Controller('v1/settlements')
@UseGuards(AuthGuard)
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  @Post('run')
  @Roles('platform_admin', 'platform_finance', 'operator_admin', 'operator_finance')
  run(
    @Headers('x-idempotency-key') key: string,
    @Body() body: { operatorId: string; businessDay: string },
    @Req() request: { auth: AuthContext },
  ) {
    const operatorId = resolveOperatorId(request.auth, body.operatorId);
    return this.settlement.run(operatorId, body.businessDay, key);
  }

  @Post(':id/override')
  @Roles('platform_finance', 'operator_finance')
  override(
    @Param('id') id: string,
    @Headers('x-idempotency-key') key: string,
    @Body() body: { operatorId: string; reason: string },
    @Req() request: { auth: AuthContext },
  ) {
    const operatorId = resolveOperatorId(request.auth, body.operatorId);
    return this.settlement.override(id, { ...body, operatorId, actorId: request.auth.userId }, key);
  }

  @Post(':id/payout')
  @Roles('platform_finance', 'operator_finance')
  payout(
    @Param('id') id: string,
    @Headers('x-idempotency-key') key: string,
    @Body() body: { operatorId: string },
    @Req() request: { auth: AuthContext },
  ) {
    const operatorId = resolveOperatorId(request.auth, body.operatorId);
    return this.settlement.payout(id, { ...body, operatorId, actorId: request.auth.userId }, key);
  }
}
