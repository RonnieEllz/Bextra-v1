import { Body, Controller, Headers, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { FundingService } from './funding.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Roles } from '../auth/auth.decorator.js';
import { AuthContext } from '../auth/auth.types.js';
import { resolveOperatorId } from '../auth/tenant.js';
import { verifyAgentStepUpToken } from '../auth/auth.service.js';

@Controller('v1')
export class FundingController {
  constructor(@Inject(FundingService) private readonly funding: FundingService) {}

  @Post('agents/topups')
  @UseGuards(AuthGuard)
  @Roles('platform_admin', 'operator_admin', 'operator_finance', 'agent')
  topUp(
    @Headers('x-idempotency-key') key: string,
    @Headers('x-request-id') requestId: string | undefined,
    @Headers('x-step-up-token') stepUpToken: string | undefined,
    @Body() body: unknown,
    @Req() request: { auth: AuthContext; stepUp?: boolean },
  ) {
    const operatorId = resolveOperatorId(request.auth, (body as { operatorId?: string })?.operatorId);
    const hasStepUp = request.stepUp || (
      request.auth.agentId && stepUpToken
        ? verifyAgentStepUpToken(stepUpToken, request.auth.userId, request.auth.agentId)
        : false
    );
    if (request.auth.role === 'agent' && !hasStepUp) {
      throw Object.assign(new Error('Agent PIN verification is required before top-up'), { status: 401, code: 'UNAUTHORIZED' });
    }
    return this.funding.topUp(body, key, requestId, operatorId, request.auth.agentId ?? undefined);
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
