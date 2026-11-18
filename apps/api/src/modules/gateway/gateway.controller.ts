import { Body, Controller, Headers, Post } from '@nestjs/common';
import { GatewayService } from './gateway.service.js';

@Controller('v1/terminals')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Post('taps/batch')
  async uploadBatch(
    @Headers('x-request-id') requestId: string | undefined,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Body() body: unknown,
  ) {
    return this.gateway.uploadBatch(body, idempotencyKey, requestId);
  }
}
