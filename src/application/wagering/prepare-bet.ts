import { prepareWager, InvalidWagerInputError, type WagerInput, type PreparedWager } from './prepare-wager.js';

export { InvalidWagerInputError } from './prepare-wager.js';
export interface BetInput extends Omit<WagerInput, 'kind' | 'referenceExternalTransactionId'> { readonly kind: 'BET'; }
export interface PreparedBet extends Omit<PreparedWager, 'input'> { readonly input: Readonly<BetInput>; }

/** Compatibility entry point: preserves BET-only admission and the original canonical bytes. */
export function prepareBet(input: BetInput): PreparedBet {
  if (input?.kind !== 'BET') throw new InvalidWagerInputError('Only BET is supported by prepareBet');
  const prepared = prepareWager(input);
  return prepared as PreparedBet; // Runtime validation above proves the narrower kind.
}
