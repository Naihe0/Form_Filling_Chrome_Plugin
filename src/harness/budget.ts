/** Run limits and cancellation, checked before every model call and page action. */
import { BudgetExhausted, RunStopped } from '../shared/errors.ts';
import { emptyUsage, type Usage } from '../shared/types.ts';

export interface Limits {
  /** Snapshot-plan-apply rounds; later rounds catch fields revealed by earlier fills. */
  maxPasses: number;
  /** Fields per planning call. */
  batchSize: number;
  maxLlmCalls: number;
  maxTotalTokens: number;
  maxDurationMs: number;
  /** Model turns allowed on a single widget. */
  maxWidgetSteps: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxPasses: 3,
  batchSize: 40,
  maxLlmCalls: 60,
  maxTotalTokens: 300_000,
  maxDurationMs: 5 * 60_000,
  maxWidgetSteps: 10,
};

export class Budget {
  readonly usage: Usage = emptyUsage();
  private readonly limits: Limits;
  private readonly signal: AbortSignal;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(limits: Limits, signal: AbortSignal, now: () => number = Date.now) {
    this.limits = limits;
    this.signal = signal;
    this.now = now;
    this.startedAt = now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Before any page action. Answers already paid for may still be applied. */
  ensureRunning(): void {
    if (this.signal.aborted) throw new RunStopped();
    if (this.elapsedMs > this.limits.maxDurationMs) throw new BudgetExhausted('duration');
  }

  /** Before any model call. */
  ensureCanCallModel(): void {
    this.ensureRunning();
    if (this.usage.calls >= this.limits.maxLlmCalls) throw new BudgetExhausted('llm-calls');
    if (this.usage.totalTokens >= this.limits.maxTotalTokens) throw new BudgetExhausted('tokens');
  }

  record(usage: Usage): void {
    this.usage.calls += usage.calls;
    this.usage.promptTokens += usage.promptTokens;
    this.usage.completionTokens += usage.completionTokens;
    this.usage.totalTokens += usage.totalTokens;
  }
}
