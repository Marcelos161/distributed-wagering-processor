export type DatabasePurpose = 'application' | 'migrations';

export function readDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  purpose: DatabasePurpose,
): string {
  const key = purpose === 'application' ? 'DATABASE_URL' : 'MIGRATION_DATABASE_URL';
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid PostgreSQL connection URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !url.hostname || !url.username || url.pathname.length <= 1) {
    throw new Error(`${key} must specify PostgreSQL host, user and database`);
  }
  return value;
}
