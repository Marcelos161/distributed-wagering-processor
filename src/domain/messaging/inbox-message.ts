import { assertIdentifier, timestamp } from './message-values.js';
export interface ReceiveInboxProps { messageId: string; consumerName: string; payloadHash: string; receivedAt: Date; }
export interface InboxMessageState extends ReceiveInboxProps { processedAt?: Date | undefined; }
const token = Symbol('InboxMessage');
export class InboxMessage {
  readonly messageId: string; readonly consumerName: string; readonly payloadHash: string;
  readonly #receivedAt: number; #processedAt: number | undefined;
  private constructor(state: InboxMessageState, key: symbol) {
    if (key !== token) throw new TypeError('Use InboxMessage factories');
    for (const value of [state.messageId, state.consumerName, state.payloadHash]) assertIdentifier(value);
    this.messageId = state.messageId; this.consumerName = state.consumerName; this.payloadHash = state.payloadHash;
    this.#receivedAt = timestamp(state.receivedAt);
    this.#processedAt = state.processedAt === undefined ? undefined : timestamp(state.processedAt);
    if (this.#processedAt !== undefined && this.#processedAt < this.#receivedAt) throw new RangeError('Processing precedes receipt');
    Object.freeze(this);
  }
  static receive(props: ReceiveInboxProps): InboxMessage { return new InboxMessage({ ...props, processedAt: undefined }, token); }
  static rehydrate(state: InboxMessageState): InboxMessage { return new InboxMessage(state, token); }
  get receivedAt(): Date { return new Date(this.#receivedAt); }
  get processedAt(): Date | undefined { return this.#processedAt === undefined ? undefined : new Date(this.#processedAt); }
  isProcessed(): boolean { return this.#processedAt !== undefined; }
  markProcessed(at: Date): void {
    const value = timestamp(at);
    if (this.isProcessed()) throw new Error('Inbox is already processed');
    if (value < this.#receivedAt) throw new RangeError('Processing precedes receipt');
    this.#processedAt = value;
  }
}
export class InboxConflictError extends Error {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';
  constructor() { super('Message identity was reused with a different payload hash'); this.name = 'InboxConflictError'; }
}
