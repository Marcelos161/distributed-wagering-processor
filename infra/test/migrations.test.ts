import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { withDisposableDatabase } from './disposable-database.js';

async function migrationCli(url: string, path: string, command: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn([
    process.execPath, 'node_modules/@mikro-orm/cli/cli.js', command,
    '--config', 'infra/test/fixtures/migration-config.ts', ...args,
  ], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MIGRATION_DATABASE_URL: url, DWP_TEST_MIGRATIONS_PATH: path, NO_COLOR: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Migration CLI failed: ${stdout}\n${stderr}`);
  return stdout;
}

test('official CLI generates, applies once, lists and reverts a migration only in a disposable database', async () => {
  await mkdir('.tools', { recursive: true });
  const path = await mkdtemp(join(process.cwd(), '.tools/migrations-'));
  try {
    await withDisposableDatabase(async (urls) => {
      const sql = new SQL(urls.migrations);
      try {
        await migrationCli(urls.migrations, path, 'migration:create', '--blank', '--name', 'InfrastructureProbe');
        const filename = (await readdir(path)).find((name) => name.endsWith('.ts'));
        if (!filename) throw new Error('CLI did not create a migration');
        const generated = await readFile(join(path, filename), 'utf8');
        const className = /export class (\w+)/.exec(generated)?.[1];
        if (!className) throw new Error('Generated migration has no exported class');
        await writeFile(join(path, filename), `import { Migration } from '@mikro-orm/migrations';
export class ${className} extends Migration {
  override async up(): Promise<void> {
    this.addSql('CREATE TABLE infrastructure_probe (id text PRIMARY KEY)');
    this.addSql('GRANT SELECT, INSERT ON infrastructure_probe TO wager_app');
  }
  override async down(): Promise<void> {
    this.addSql('DROP TABLE infrastructure_probe');
  }
}
`);
        // Initialize tracking before comparing user schema: down preserves migration metadata.
        await migrationCli(urls.migrations, path, 'migration:list');
        const baseline = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
        expect(await migrationCli(urls.migrations, path, 'migration:pending')).toContain(className);
        await migrationCli(urls.migrations, path, 'migration:up');
        expect((await sql`SELECT to_regclass('public.infrastructure_probe')::text AS name`)[0]?.name)
          .toBe('infrastructure_probe');
        expect((await sql`SELECT count(*)::text AS count FROM mikro_orm_migrations`)[0]?.count).toBe('1');
        expect(await migrationCli(urls.migrations, path, 'migration:list')).toContain(className);
        await migrationCli(urls.migrations, path, 'migration:up');
        expect((await sql`SELECT count(*)::text AS count FROM mikro_orm_migrations`)[0]?.count).toBe('1');

        const app = await MikroORM.init(createOrmOptions(urls.application));
        try {
          const em = app.em.fork();
          await em.transactional(async (transaction) => {
            await transaction.execute('INSERT INTO infrastructure_probe (id) VALUES (?)', ['committed']);
          });
          await expect(em.transactional(async (transaction) => {
            await transaction.execute('INSERT INTO infrastructure_probe (id) VALUES (?)', ['rolled-back']);
            throw new Error('intentional transaction failure');
          })).rejects.toThrow('intentional transaction failure');
          expect(await sql`SELECT id FROM infrastructure_probe ORDER BY id`).toEqual([{ id: 'committed' }]);
          await expect(em.execute('DROP TABLE infrastructure_probe')).rejects.toThrow();
          await expect(em.execute('CREATE TABLE forbidden_probe (id text)')).rejects.toThrow();
          await expect(em.execute('SELECT * FROM mikro_orm_migrations')).rejects.toThrow();
        } finally {
          await app.close();
        }
        await migrationCli(urls.migrations, path, 'migration:down');
        expect(await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
          .toEqual(baseline);
        expect((await sql`SELECT count(*)::text AS count FROM mikro_orm_migrations`)[0]?.count).toBe('0');
        console.log('Verified: generated migration, up, SQL table, one history row, app grants, transaction rollback, down, restored baseline');
      } finally {
        await sql.close();
      }
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}, 60_000);

test('a failed migration rolls back both its DDL and earlier migrations in the same batch', async () => {
  await mkdir('.tools', { recursive: true });
  const path = await mkdtemp(join(process.cwd(), '.tools/migrations-failure-'));
  try {
    await writeFile(join(path, 'Migration20990101000001.ts'), `import { Migration } from '@mikro-orm/migrations';
export class Migration20990101000001 extends Migration {
  override async up(): Promise<void> { this.addSql('CREATE TABLE batch_probe (id text)'); }
  override async down(): Promise<void> { this.addSql('DROP TABLE batch_probe'); }
}
`);
    await writeFile(join(path, 'Migration20990101000002.ts'), `import { Migration } from '@mikro-orm/migrations';
export class Migration20990101000002 extends Migration {
  override async up(): Promise<void> {
    this.addSql('CREATE TABLE failure_probe (id text)');
    this.addSql('SELECT 1 / 0');
  }
  override async down(): Promise<void> { this.addSql('DROP TABLE failure_probe'); }
}
`);
    await withDisposableDatabase(async (urls) => {
      const sql = new SQL(urls.migrations);
      try {
        await expect(migrationCli(urls.migrations, path, 'migration:up')).rejects.toThrow('division by zero');
        expect((await sql`SELECT to_regclass('public.batch_probe')::text AS name`)[0]?.name).toBeNull();
        expect((await sql`SELECT to_regclass('public.failure_probe')::text AS name`)[0]?.name).toBeNull();
        expect((await sql`SELECT count(*)::text AS count FROM mikro_orm_migrations`)[0]?.count).toBe('0');
        expect(await migrationCli(urls.migrations, path, 'migration:pending')).toContain('Migration20990101000001');
      } finally {
        await sql.close();
      }
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);
