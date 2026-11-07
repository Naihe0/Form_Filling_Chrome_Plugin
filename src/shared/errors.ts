/** Error types that cross module (and, once serialized, process) boundaries. */

export type LlmErrorCode =
  | 'auth'
  | 'model_not_found'
  | 'quota'
  | 'rate_limited'
  | 'bad_request'
  | 'bad_response'
  | 'refused'
  | 'server'
  | 'network'
  | 'timeout'
  | 'not_configured';

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set([
  'rate_limited',
  'server',
  'network',
  'timeout',
  'bad_response',
]);

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfter?: number;
  /** Request parameter the provider rejected, when it said. */
  readonly param?: string;

  constructor(
    code: LlmErrorCode,
    message: string,
    extra: { retryAfter?: number; param?: string } = {}
  ) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAfter = extra.retryAfter;
    this.param = extra.param;
  }
}

/** The user pressed Stop. Not a failure; unwinds the run. */
export class RunStopped extends Error {
  constructor() {
    super('Run stopped by the user.');
    this.name = 'RunStopped';
  }
}

/** A run limit (calls, tokens, wall clock) was hit. */
export class BudgetExhausted extends Error {
  readonly limit: string;

  constructor(limit: string) {
    super(`Run budget exhausted: ${limit}.`);
    this.name = 'BudgetExhausted';
    this.limit = limit;
  }
}
