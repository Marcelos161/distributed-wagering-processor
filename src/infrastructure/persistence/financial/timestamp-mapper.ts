/** Raw MikroORM SQL returns timestamptz strings; domain factories require Date. */
export function readTimestamp(value: Date | string): Date {
  if (!(value instanceof Date) && (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value))) {
    throw new TypeError('Timestamp must be a finite Date or millisecond timestamp with explicit timezone');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid persisted timestamp');
  return date;
}
