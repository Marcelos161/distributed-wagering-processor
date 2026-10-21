import { SQL } from 'bun';
import { compose } from './compose.js';

export async function withDisposableDatabase(
  run: (urls: { application: string; migrations: string }) => Promise<void>,
): Promise<void> {
  const config = JSON.parse(await compose('config', '--format', 'json')) as {
    services: { postgres: { environment: Record<string, string>; ports: Array<{ published: string }> } };
  };
  const service = config.services.postgres;
  const name = `dwp_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new URL(`postgresql://127.0.0.1:${service.ports[0]?.published}/postgres`);
  admin.username = service.environment['POSTGRES_USER']!;
  admin.password = service.environment['POSTGRES_PASSWORD']!;
  const control = new SQL(admin.href, { max: 1, connectionTimeout: 5 });
  let created = false;
  try {
    await control.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    admin.pathname = `/${name}`;
    const application = new URL(admin);
    application.username = 'wager_app';
    application.password = service.environment['POSTGRES_APP_PASSWORD']!;
    await run({ application: application.href, migrations: admin.href });
  } finally {
    try {
      if (created) await control.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await control.close();
    }
  }
}
