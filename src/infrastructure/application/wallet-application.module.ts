import { Module } from '@nestjs/common';
import { CreateWallet } from '../../application/wallet/create-wallet.js';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWork } from '../../application/ports/financial-persistence.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SystemClock, UuidGenerator } from './runtime.js';

@Module({
  imports: [PersistenceModule],
  providers: [{
    provide: CreateWallet,
    inject: [FINANCIAL_UNIT_OF_WORK],
    useFactory: (unit: FinancialUnitOfWork) => new CreateWallet(unit, new UuidGenerator(), new SystemClock()),
  }],
  exports: [CreateWallet],
})
export class WalletApplicationModule {}
