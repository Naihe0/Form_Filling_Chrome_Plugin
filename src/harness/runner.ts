/**
 * The form-filling run loop.
 *
 *   repeat up to maxPasses:
 *     snapshot the page -> pick fields still to do -> plan answers with the
 *     model -> validate them -> apply each -> read each back
 *   then audit every filled field once more, since a later fill can reset an
 *   earlier one.
 *
 * The model only decides values. Perception, execution, verification, limits
 * and the final report all belong to this loop, so the report states what the
 * page actually holds rather than what the model believes it did.
 */
import { BudgetExhausted, LlmError, RunStopped } from '../shared/errors.ts';
import type {
  FieldOutcome,
  FieldView,
  OutcomeStatus,
  PageSnapshot,
  RunError,
  RunReport,
  RunStatus,
} from '../shared/types.ts';
import { resolveAnswers, type ResolvedAnswer } from './answers.ts';
import { Budget, DEFAULT_LIMITS, type Limits } from './budget.ts';
import { coerceForInput, textMatches } from './match.ts';
import type { FieldReading, LlmClient, PageDriver, RunEvent, RunOptions } from './types.ts';
import { fillWidget, type WidgetContext, type WidgetResult } from './widget.ts';

export interface RunDeps {
  page: PageDriver;
  llm: LlmClient;
  signal: AbortSignal;
  options: RunOptions;
  limits?: Partial<Limits>;
  emit?: (event: RunEvent) => void;
  now?: () => number;
}

interface Applied {
  field: FieldView;
  answer: ResolvedAnswer;
}

function outcomeFor(
  field: FieldView,
  status: OutcomeStatus,
  detail?: string
): FieldOutcome {
  return {
    fieldId: field.id,
    label: field.label,
    kind: field.kind,
    required: field.required,
    status,
    ...(detail ? { detail } : {}),
  };
}

/** Compares a read-back against the applied answer. */
function judgeReading(
  field: FieldView,
  answer: ResolvedAnswer,
  reading: FieldReading
): { status: OutcomeStatus; detail?: string } {
  if (!reading.exists) return { status: 'failed', detail: 'stale' };

  if (answer.kind === 'text') {
    const expected = coerceForInput(field.inputType, answer.text);
    if (textMatches(expected, reading.value, field.inputType)) return { status: 'filled' };
    return reading.value.trim()
      ? { status: 'unconfirmed', detail: 'value-differs' }
      : { status: 'failed', detail: 'verify-failed' };
  }

  if (answer.kind === 'options') {
    if (reading.selected === null) return { status: 'unconfirmed', detail: 'no-readable-state' };
    const selected = reading.selected;
    return answer.optionIds.every((id) => selected.includes(id))
      ? { status: 'filled' }
      : { status: 'failed', detail: 'verify-failed' };
  }

  return { status: 'filled' };
}

export async function runFill(deps: RunDeps): Promise<RunReport> {
  const { page, llm, signal, options } = deps;
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const emit = deps.emit ?? (() => {});
  const budget = new Budget(limits, signal, deps.now);
  const widgetCtx: WidgetContext = { page, llm, budget, limits, signal, emit };

  const outcomes = new Map<string, FieldOutcome>();
  const applied = new Map<string, Applied>();
  let total = 0;
  let passes = 0;

  const finished = () =>
    [...outcomes.values()].filter((outcome) => !['blocked', 'prefilled'].includes(outcome.status))
      .length;

  const settleOutcome = (field: FieldView, status: OutcomeStatus, detail?: string) => {
    const outcome = outcomeFor(field, status, detail);
    outcomes.set(field.id, outcome);
    page.mark(
      field.id,
      status === 'filled' ? 'filled' : status === 'skipped' && !field.required ? 'clear' : 'attention'
    );
    emit({ type: 'field-done', outcome, done: finished(), total });
  };

  /** Writes one answer and judges it from a read-back. */
  const applyAnswer = async (field: FieldView, answer: ResolvedAnswer): Promise<void> => {
    if (answer.kind === 'none') {
      settleOutcome(field, 'skipped', 'no-profile-data');
      return;
    }

    emit({ type: 'field-start', fieldId: field.id, label: field.label, done: finished(), total });
    page.mark(field.id, 'working');
    applied.set(field.id, { field, answer });

    if (answer.kind === 'path') {
      const result: WidgetResult = await fillWidget(widgetCtx, field, answer.path);
      settleOutcome(field, result.status, result.detail);
      return;
    }

    const action =
      answer.kind === 'text'
        ? await page.fillText(field.id, coerceForInput(field.inputType, answer.text))
        : await page.selectOptions(field.id, answer.optionIds);

    if (!action.ok) {
      settleOutcome(field, 'failed', action.code);
      return;
    }

    const judged = judgeReading(field, answer, await page.readField(field.id));
    settleOutcome(field, judged.status, judged.detail);
  };

  const processBatch = async (snapshot: PageSnapshot, batch: FieldView[]) => {
    budget.ensureCanCallModel();
    emit({ type: 'plan-start', pass: passes, fields: batch.length });

    const base = { host: snapshot.host, title: snapshot.title };
    const first = await llm.plan({ ...base, fields: batch }, signal);
    budget.record(first.usage);
    let resolution = resolveAnswers(batch, first.value);

    // One repair round: show the model exactly what it got wrong.
    if (resolution.errors.size > 0) {
      budget.ensureCanCallModel();
      const bad = batch.filter((field) => resolution.errors.has(field.id));
      const feedback = [...resolution.errors.values()].join('\n');
      const retry = await llm.plan({ ...base, fields: bad, feedback }, signal);
      budget.record(retry.usage);

      const repaired = resolveAnswers(bad, retry.value);
      resolution = {
        answers: new Map([...resolution.answers, ...repaired.answers]),
        errors: repaired.errors,
      };
    }

    emit({
      type: 'plan-done',
      answered: [...resolution.answers.values()].filter((answer) => answer.kind !== 'none').length,
      invalid: resolution.errors.size,
      usage: first.usage,
    });

    for (const field of batch) {
      budget.ensureRunning();
      if (resolution.errors.has(field.id)) {
        settleOutcome(field, 'failed', 'invalid-answer');
        continue;
      }
      await applyAnswer(field, resolution.answers.get(field.id) ?? { kind: 'none' });
    }
  };

  /** A later fill can reset an earlier one; re-check and retry once. */
  const audit = async () => {
    let checked = 0;
    let reverted = 0;

    for (const [fieldId, { field, answer }] of applied) {
      if (outcomes.get(fieldId)?.status !== 'filled' || answer.kind === 'path') continue;
      budget.ensureRunning();

      const reading = await page.readField(fieldId);
      // A field that vanished was hidden by later answers; it no longer matters.
      if (!reading.exists) continue;
      checked++;
      if (judgeReading(field, answer, reading).status === 'filled') continue;

      reverted++;
      await applyAnswer(field, answer);
      if (outcomes.get(fieldId)?.status !== 'filled') {
        settleOutcome(field, 'failed', 'reverted');
      }
    }
    emit({ type: 'audit', checked, reverted });
  };

  let status: RunStatus = 'completed';
  let error: RunError | undefined;

  try {
    for (let pass = 1; pass <= limits.maxPasses; pass++) {
      budget.ensureRunning();
      const snapshot = await page.snapshot();

      for (const field of snapshot.fields) {
        if (outcomes.has(field.id)) continue;
        if (field.blocked) {
          outcomes.set(field.id, outcomeFor(field, 'blocked', field.blocked));
          page.mark(field.id, 'attention');
        } else if (field.filled && !options.overwrite) {
          outcomes.set(field.id, outcomeFor(field, 'prefilled'));
        }
      }

      // A field replaced by a re-render comes back under a new id, so only
      // failures from a stale element earn another attempt.
      const pending = snapshot.fields.filter((field) => {
        if (field.blocked) return false;
        const previous = outcomes.get(field.id);
        return !previous || (previous.status === 'failed' && previous.detail === 'stale');
      });

      total = finished() + pending.length;
      emit({
        type: 'snapshot',
        pass,
        total: snapshot.fields.length,
        pending: pending.length,
        blocked: snapshot.fields.filter((field) => field.blocked).length,
      });
      if (pending.length === 0) break;

      passes = pass;
      for (let i = 0; i < pending.length; i += limits.batchSize) {
        await processBatch(snapshot, pending.slice(i, i + limits.batchSize));
      }
      await page.settle();
    }
    await audit();
  } catch (cause) {
    if (cause instanceof RunStopped || signal.aborted) {
      status = 'stopped';
    } else if (cause instanceof BudgetExhausted) {
      status = 'budget-exhausted';
      error = { code: cause.limit, message: cause.message };
    } else {
      status = 'failed';
      error = {
        code: cause instanceof LlmError ? cause.code : 'internal',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  // A re-render reissues a field under a new id. Once the new one has an
  // outcome, the old id's "stale" failure no longer describes anything real.
  const settled = [...outcomes.values()];
  const finalOutcomes = settled.filter(
    (outcome) =>
      outcome.detail !== 'stale' ||
      !settled.some(
        (other) =>
          other !== outcome &&
          other.label === outcome.label &&
          other.kind === outcome.kind &&
          other.detail !== 'stale'
      )
  );

  const report: RunReport = {
    status,
    ...(error ? { error } : {}),
    outcomes: finalOutcomes,
    usage: { ...budget.usage },
    passes,
    durationMs: budget.elapsedMs,
  };
  emit({ type: 'run-end', report });
  return report;
}
