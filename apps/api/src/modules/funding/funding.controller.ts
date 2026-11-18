import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { FundingService } from './funding.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Roles } from '../auth/auth.decorator.js';
import { AuthContext } from '../auth/auth.types.js';
import { resolveOperatorId } from '../auth/tenant.js';

@Controller('v1')
export class FundingController {
  constructor(private readonly funding: FundingService) {}

  @Post('agents/topups')
  @UseGuards(AuthGuard)
  @Roles('platform_admin', 'operator_admin', 'operator_finance')
  topUp(
    @Headers('x-idempotency-key') key: string,
    @Headers('x-request-id') requestId: string | undefined,
    @Body() body: unknown,
    @Req() request: { auth: AuthContext },
  ) {
    const operatorId = resolveOperatorId(request.auth, (body as { operatorId?: string })?.operatorId);
    return this.funding.topUp(body, key, requestId, operatorId);
  }

  @Post('webhooks/provider')
  providerWebhook(
    @Headers('x-idempotency-key') key: string,
    @Headers('x-request-id') requestId: string | undefined,
    @Body() body: unknown,
  ) {
    return this.funding.providerWebhook(body, key, requestId);
  }
}
