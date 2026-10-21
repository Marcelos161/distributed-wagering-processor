import { SQL } from 'bun';
import { fileURLToPath } from 'node:url';

export async function compose(...args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', 'compose', ...args], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`docker compose ${args[0]} failed: ${stderr}`);
  return stdout;
}

export async function postgres(role: 'admin' | 'app'): Promise<SQL> {
  const config = JSON.parse(await compose('config', '--format', 'json')) as {
    services: {
      postgres: {
        environment: Record<string, string>;
        ports: Array<{ published: string }>;
      };
    };
  };
  const service = config.services.postgres;
  return new SQL({
    hostname: '127.0.0.1',
    port: Number(service.ports[0]?.published),
    database: service.environment['POSTGRES_DB']!,
    username: role === 'admin' ? service.environment['POSTGRES_USER']! : 'wager_app',
    password: service.environment[role === 'admin' ? 'POSTGRES_PASSWORD' : 'POSTGRES_APP_PASSWORD']!,
    max: 1,
    connectionTimeout: 5,
  });
}
