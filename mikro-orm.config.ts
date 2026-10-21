import { readDatabaseUrl } from './src/infrastructure/persistence/database-url.js';
import { createMigrationOptions } from './scripts/migration-options.js';

export default createMigrationOptions(readDatabaseUrl(process.env, 'migrations'));
