import { expect, test } from 'bun:test';
import { readDatabaseUrl } from '../src/infrastructure/persistence/database-url.js';
import { createOrmOptions } from '../src/infrastructure/persistence/orm-options.js';

test('application and migrations read only their own connection variable', () => {
  const env = {
    DATABASE_URL: 'postgresql://app:local@localhost/app_db',
    MIGRATION_DATABASE_URL: 'postgresql://migrator:local@localhost/app_db',
  };
  expect(readDatabaseUrl(env, 'application')).toBe(env.DATABASE_URL);
  expect(readDatabaseUrl(env, 'migrations')).toBe(env.MIGRATION_DATABASE_URL);
  expect(() => readDatabaseUrl({ MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL }, 'application'))
    .toThrow('DATABASE_URL is required');
  expect(() => readDatabaseUrl({ DATABASE_URL: env.DATABASE_URL }, 'migrations'))
    .toThrow('MIGRATION_DATABASE_URL is required');
});

test.each(['', 'invalid-secret', 'mysql://app:secret@localhost/db', 'postgresql://localhost/db', 'postgresql://app:secret@localhost'])
('rejects an invalid PostgreSQL URL without disclosing it: case %#', (value) => {
  expect(() => readDatabaseUrl({ DATABASE_URL: value }, 'application')).toThrow('DATABASE_URL');
  try {
    readDatabaseUrl({ DATABASE_URL: value }, 'application');
  } catch (error) {
    expect(String(error)).not.toContain('secret');
  }
});

test('ORM configuration does not create schema or share a global identity map', () => {
  const options = createOrmOptions('postgresql://app:local@localhost/app_db');
  expect(options.ensureDatabase).toBe(false);
  expect(options.ensureIndexes).toBe(false);
  expect(options.allowGlobalContext).toBe(false);
  expect(options.entities).toEqual([]);
});
