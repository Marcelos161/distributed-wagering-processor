import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '../../application/ports/runtime.js';

export class UuidGenerator implements IdGenerator {
  next(): string { return randomUUID(); }
}
export class SystemClock implements Clock {
  now(): Date { return new Date(); }
}
