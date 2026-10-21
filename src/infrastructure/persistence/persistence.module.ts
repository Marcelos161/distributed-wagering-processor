import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ApplicationDatabaseCheck } from './application-database-check.js';
import { readDatabaseUrl } from './database-url.js';
import { createOrmOptions } from './orm-options.js';

@Module({
  imports: [MikroOrmModule.forRootAsync({
    driver: PostgreSqlDriver,
    useFactory: () => createOrmOptions(readDatabaseUrl(process.env, 'application')),
  })],
  providers: [ApplicationDatabaseCheck],
})
export class PersistenceModule {}
