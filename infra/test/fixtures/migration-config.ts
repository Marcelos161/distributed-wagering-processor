import { createMigrationOptions } from '../../../scripts/migration-options.js';
import { readDatabaseUrl } from '../../../src/infrastructure/persistence/database-url.js';

const url = readDatabaseUrl(process.env, 'migrations');
if (!/^\/dwp_test_[a-f0-9]{32}$/.test(new URL(url).pathname)) {
  throw new Error('Migration fixture requires a disposable dwp_test database');
}
const path = process.env['DWP_TEST_MIGRATIONS_PATH'];
if (!path) throw new Error('DWP_TEST_MIGRATIONS_PATH is required');

export default createMigrationOptions(url, path);
