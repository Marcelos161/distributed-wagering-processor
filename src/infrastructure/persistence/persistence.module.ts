import { FINANCIAL_UNIT_OF_WORK } from '../../application/ports/financial-persistence.js';
import { MikroFinancialUnitOfWork } from './financial/financial-unit-of-work.js';
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ApplicationDatabaseCheck } from './application-database-check.js';
import { readDatabaseUrl } from './database-url.js';
import { createOrmOptions } from './orm-options.js';

@Module({
  imports: [MikroOrmModule.forRootAsync({
    driver: PostgreSqlDriver,
    useFactory: () => createOrmOptions(readDatabaseUrl(process.env, 'application')),
  })],
  providers: [ApplicationDatabaseCheck, {
    provide: FINANCIAL_UNIT_OF_WORK,
    inject: [MikroORM],
    useFactory: (orm: MikroORM) => new MikroFinancialUnitOfWork(orm),
  }],
  exports: [FINANCIAL_UNIT_OF_WORK],
})
export class PersistenceModule {}
