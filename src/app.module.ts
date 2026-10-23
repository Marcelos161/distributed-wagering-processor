import { MetricsController } from './infrastructure/http/metrics.controller.js';
import { FinancialController } from './infrastructure/http/financial.controller.js';
import { FinancialQueries } from './application/queries/financial-queries.js';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWork } from './application/ports/financial-persistence.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { ProviderIdentityGuard } from './infrastructure/http/provider-identity.guard.js';
import { Module } from '@nestjs/common';
import { HealthController } from './infrastructure/http/health.controller.js';
import { WalletApplicationModule } from './infrastructure/application/wallet-application.module.js';
import { WagerApplicationModule } from './infrastructure/application/wager-application.module.js';

@Module({ imports: [PersistenceModule, WalletApplicationModule, WagerApplicationModule], controllers: [HealthController, FinancialController, MetricsController], providers: [ProviderIdentityGuard, { provide: FinancialQueries, inject: [FINANCIAL_UNIT_OF_WORK], useFactory: (unit: FinancialUnitOfWork) => new FinancialQueries(unit) }] })
export class AppModule {}
