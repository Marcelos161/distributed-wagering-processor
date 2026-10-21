import { expect, test } from 'bun:test';
import { compose, postgres } from './compose.js';

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
  const table = `infra_probe_${crypto.randomUUID().replaceAll('-', '')}`;
  const marker = crypto.randomUUID();
  let sql = await postgres('admin');
  try {
    await sql.unsafe(`CREATE TABLE ${table} (marker text NOT NULL)`);
    await sql.unsafe(`INSERT INTO ${table} (marker) VALUES ($1)`, [marker]);
    await sql.close();

    await compose('restart', 'postgres');
    await compose('up', '-d', '--wait', '--wait-timeout', '90', 'postgres');
    sql = await postgres('admin');
    expect((await sql.unsafe(`SELECT marker FROM ${table}`))[0]?.marker).toBe(marker);
    await sql.close();

    await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90', 'postgres');
    sql = await postgres('admin');
    expect((await sql.unsafe(`SELECT marker FROM ${table}`))[0]?.marker).toBe(marker);
  } finally {
    await sql.close();
    const cleanup = await postgres('admin');
    try {
      await cleanup.unsafe(`DROP TABLE IF EXISTS ${table}`);
    } finally {
      await cleanup.close();
    }
  }
}, 120_000);
