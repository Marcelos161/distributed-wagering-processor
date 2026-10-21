import { fileURLToPath } from 'node:url';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../src/infrastructure/persistence/orm-options.js';

export function createMigrationOptions(
  clientUrl: string,
  path = fileURLToPath(new URL('../migrations/', import.meta.url)),
) {
  return defineConfig({
    ...createOrmOptions(clientUrl),
    extensions: [Migrator],
    migrations: {
      path,
      pathTs: path,
      glob: 'Migration*.{ts,js}',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: false,
      snapshot: false,
      emit: 'ts',
    },
  });
}
