import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from '../../src/create-application.js';
import { ApplicationDatabaseCheck } from '../../src/infrastructure/persistence/application-database-check.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { withDisposableDatabase } from './disposable-database.js';

test('Nest injects a real PostgreSQL ORM using only the application role', async () => {
  await withDisposableDatabase(async (urls) => {
    const previous = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = urls.application;
    const app = await createApplication({ logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const orm = app.get(MikroORM);
      const em = orm.em.fork();
      const result = await em.execute<Array<{ username: string; database: string }>>(
        'SELECT current_user AS username, current_database() AS database',
      );
      expect(result[0]?.username).toBe('wager_app');
      expect(result[0]?.database).toStartWith('dwp_test_');
      expect(await em.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
        .toEqual([]);
      const response = await fetch(`${await app.getUrl()}/health/live`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      await expect(em.execute('CREATE TABLE forbidden_probe (id text)')).rejects.toThrow();
    } finally {
      await app.close();
      if (previous === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = previous;
    }
  });
}, 20_000);

test('startup database check rejects an administrative connection', async () => {
  await withDisposableDatabase(async (urls) => {
    const orm = await MikroORM.init(createOrmOptions(urls.migrations));
    try {
      await expect(new ApplicationDatabaseCheck(orm).onModuleInit())
        .rejects.toThrow('non-administrative application role');
    } finally {
      await orm.close();
    }
  });
}, 20_000);
