import { Body, Controller, Logger, OnModuleDestroy, OnModuleInit, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { AuthContext } from './auth.types.js';

@Controller('v1/auth')
export class AuthController implements OnModuleInit, OnModuleDestroy {
  private readonly auth = new AuthService();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  onModuleInit() {
    const cleanup = () => {
      void this.auth.cleanupExpiredCustomerRegistrations().catch(() => {
        Logger.error('Failed to clean up expired customer registration data', AuthController.name);
      });
    };
    cleanup();
    this.cleanupTimer = setInterval(cleanup, 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  @Post('login')
  login(@Body() body: { externalId: string; password: string }) {
    return this.auth.login(body.externalId, body.password);
  }

  @Post('agent-setup')
  completeAgentSetup(@Body() body: { setupToken: string; password: string; pin: string }) {
    return this.auth.completeAgentSetup(body.setupToken, body.password, body.pin);
  }

  @Post('otp/request')
  requestOtp(@Body() body: { phone: string }) {
    return this.auth.requestOtp(body.phone);
  }

  @Post('otp/verify')
  verifyOtp(@Body() body: { phone: string; otp: string }) {
    return this.auth.verifyOtp(body.phone, body.otp);
  }

  @Post('customer-registration/otp/request')
  requestCustomerRegistrationOtp(
    @Body() body: {
      fullName?: unknown;
      phone?: unknown;
      gender?: unknown;
      email?: unknown;
      location?: unknown;
    } | undefined,
  ) {
    return this.auth.requestCustomerRegistrationOtp(body);
  }

  @Post('customer-registration/otp/verify')
  verifyCustomerRegistrationOtp(@Body() body: { phone?: unknown; otp?: unknown } | undefined) {
    return this.auth.verifyCustomerRegistrationOtp(body?.phone, body?.otp);
  }

  @Post('agent-pin/verify')
  @UseGuards(AuthGuard)
  async verifyAgentPin(
    @Body() body: { agentId: string; pin: string },
    @Req() request: { auth: AuthContext },
  ) {
    return this.auth.verifyAgentPin(request.auth, body.agentId, body.pin);
  }
}
