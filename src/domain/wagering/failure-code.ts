/** Business outcomes, not HTTP status codes. IdempotencyConflict is admission-only. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  DomainRuleViolation = 'DOMAIN_RULE_VIOLATION',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
}
