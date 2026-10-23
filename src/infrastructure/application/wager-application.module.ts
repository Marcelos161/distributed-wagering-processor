import { Module } from '@nestjs/common';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWork } from '../../application/ports/financial-persistence.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { UuidGenerator, SystemClock } from './runtime.js';

@Module({ imports: [PersistenceModule], providers: [{ provide: ProcessWagerTransaction,
  inject: [FINANCIAL_UNIT_OF_WORK],
  useFactory: (unit: FinancialUnitOfWork) => new ProcessWagerTransaction(unit, new UuidGenerator(), new SystemClock()),
}], exports: [ProcessWagerTransaction] })
export class WagerApplicationModule {}
