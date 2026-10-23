export function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid message identifier');
}

export function timestamp(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('Invalid message timestamp');
  return value.getTime();
}

/** Copy plain JSON recursively; refuse lossy JSON conversions and freeze every level. */
export function immutableJson<T>(value: T, ancestors = new Set<object>()): T {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new TypeError('Expected acyclic JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Expected plain JSON object');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map(item => immutableJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJson(item, ancestors)]));
  ancestors.delete(value);
  return Object.freeze(result) as T;
}
