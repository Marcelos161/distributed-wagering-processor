import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { compose, postgres } from './compose.js';
import { withDisposableDatabase } from './disposable-database.js';

test('PostgreSQL accepts authenticated application SQL without superuser privileges', async () => {
  const sql = await postgres('app');
  try {
    const rows = await sql`SELECT current_user AS username, rolsuper, rolcreatedb, rolcreaterole
      FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({
      username: 'wager_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false,
    });
  } finally {
    await sql.close();
  }
});

test('PostgreSQL preserves a committed record across restart and container recreation', async () => {
  await withDisposableDatabase(async (urls) => {
    const marker = crypto.randomUUID();
    let sql = new SQL(urls.migrations);
    try {
      await sql`CREATE TABLE infrastructure_probe (marker text NOT NULL)`;
      await sql`INSERT INTO infrastructure_probe (marker) VALUES (${marker})`;
      await sql.close();

      await compose('restart', 'postgres');
      await compose('up', '-d', '--wait', '--wait-timeout', '90', 'postgres');
      sql = new SQL(urls.migrations);
      expect((await sql`SELECT marker FROM infrastructure_probe`)[0]?.marker).toBe(marker);
      await sql.close();

      await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90', 'postgres');
      sql = new SQL(urls.migrations);
      expect((await sql`SELECT marker FROM infrastructure_probe`)[0]?.marker).toBe(marker);
    } finally {
      await sql.close();
    }
  });
}, 120_000);
