import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';

@Controller('v1/auth')
export class AuthController {
  private readonly auth = new AuthService();

  @Post('login')
  login(@Body() body: { externalId: string; password: string }) {
    return this.auth.login(body.externalId, body.password);
  }
}
