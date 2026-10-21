import { Module } from '@nestjs/common';
import { HealthController } from './infrastructure/http/health.controller.js';

@Module({ controllers: [HealthController] })
export class AppModule {}
