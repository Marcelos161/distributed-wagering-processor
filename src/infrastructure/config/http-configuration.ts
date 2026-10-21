export interface HttpConfiguration {
  readonly host: string;
  readonly port: number;
}

export function readHttpConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): HttpConfiguration {
  const rawPort = env['PORT'] ?? '3000';
  if (!/^[0-9]+$/.test(rawPort)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const host = env['HOST'] ?? '127.0.0.1';
  if (host.trim().length === 0 || host !== host.trim()) {
    throw new Error('HOST must be non-empty and have no surrounding whitespace');
  }

  return { host, port };
}
