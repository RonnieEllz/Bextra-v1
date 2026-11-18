import { Module } from '@nestjs/common';
import { GatewayController } from './modules/gateway/gateway.controller.js';
import { GatewayService } from './modules/gateway/gateway.service.js';
import { FundingController } from './modules/funding/funding.controller.js';
import { FundingService } from './modules/funding/funding.service.js';
import { SettlementController } from './modules/settlement/settlement.controller.js';
import { SettlementService } from './modules/settlement/settlement.service.js';
import { DevicesController } from './modules/devices/devices.controller.js';
import { AdminController } from './modules/admin/admin.controller.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { Reflector } from '@nestjs/core';

@Module({
  controllers: [AuthController, GatewayController, FundingController, SettlementController, DevicesController, AdminController],
  providers: [GatewayService, FundingService, SettlementService, AuthService, AuthGuard, Reflector],
})
export class AppModule {}
