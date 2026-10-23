import { Module } from '@nestjs/common';
import { HealthController } from './infrastructure/http/health.controller.js';
import { WalletApplicationModule } from './infrastructure/application/wallet-application.module.js';

@Module({ imports: [WalletApplicationModule], controllers: [HealthController] })
export class AppModule {}
