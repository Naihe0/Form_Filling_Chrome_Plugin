/**
 * Fills widgets a single write cannot handle: custom dropdowns, search
 * selects, cascaders, calendars.
 *
 * Deterministic first: open it, click the option whose text equals the target.
 * That needs no model call and covers most dropdowns. Only when that fails does
 * a bounded observe-act loop hand decisions to the model, and its "done" is a
 * claim the harness checks by reading the field back, not a fact it accepts.
 */
import { LlmError } from '../shared/errors.ts';
import type { FieldView, OutcomeStatus } from '../shared/types.ts';
import type { Budget, Limits } from './budget.ts';
import { displayMatches, findOptionIndex, sameText } from './match.ts';
import type {
  ActionResult,
  LlmClient,
  PageDriver,
  RunEvent,
  WidgetDecision,
  WidgetElement,
  WidgetView,
} from './types.ts';

export interface WidgetContext {
  page: PageDriver;
  llm: LlmClient;
  budget: Budget;
  limits: Limits;
  signal: AbortSignal;
  emit: (event: RunEvent) => void;
}

export interface WidgetResult {
  status: OutcomeStatus;
  detail?: string;
}

/** Times the model may claim "done" against what the field actually shows. */
const MAX_REJECTED_CLAIMS = 2;
/** Settle rounds to wait for search results, which arrive after a network call. */
const SEARCH_RESULT_ROUNDS = 10;

function findChoice(view: WidgetView, segment: string): WidgetElement | undefined {
  const choices = view.elements.filter(
    (element) => !element.trigger && !element.disabled && element.role !== 'input'
  );
  const exact = choices.filter((element) => sameText(element.text, segment));
  const exactHit = exact.find((element) => element.popup) ?? exact[0];
  if (exactHit) return exactHit;

  const inPopup = choices.filter((element) => element.popup);
  const index = findOptionIndex(inPopup.map((element) => element.text), segment);
  return inPopup[index];
}

async function verified(ctx: WidgetContext, field: FieldView, target: string[]): Promise<boolean> {
  const reading = await ctx.page.readField(field.id);
  return reading.exists && displayMatches(target, reading.value, field.widget);
}

/** Typing a date works on any picker with an editable input, and needs no calendar. */
async function tryTypedDate(ctx: WidgetContext, field: FieldView, target: string[]): Promise<boolean> {
  const view = await ctx.page.widgetView(field.id);
  const input = view?.elements.find((element) => element.role === 'input' && !element.popup);
  if (!input) return false;

  const typed = await ctx.page.widgetType(input.ref, target[0]);
  if (!typed.ok) return false;
  await ctx.page.widgetPress(input.ref, 'Enter');
  await ctx.page.settle();

  // Text in the box proves nothing until the picker has taken it, so close it
  // first: one that rejected the date goes back to what it showed before.
  await ctx.page.closeWidget(field.id);
  await ctx.page.settle();
  return verified(ctx, field, target);
}

/** Opens the widget if it is closed, and returns the resulting view. */
async function ensureOpen(ctx: WidgetContext, field: FieldView): Promise<WidgetView | null> {
  const view = await ctx.page.widgetView(field.id);
  if (!view || view.open) return view;

  const trigger = view.elements.find((element) => element.trigger);
  if (!trigger || !(await ctx.page.widgetClick(trigger.ref)).ok) return view;
  await ctx.page.settle();
  return ctx.page.widgetView(field.id);
}

/** Opens the widget and picks each path segment by exact text. */
async function tryDirectPick(ctx: WidgetContext, field: FieldView, target: string[]): Promise<boolean> {
  const { page } = ctx;
  let view = await ensureOpen(ctx, field);
  if (!view) return false;

  for (const segment of target) {
    ctx.budget.ensureRunning();
    let choice = findChoice(view, segment);

    if (!choice) {
      const search = view.elements.find((element) => element.role === 'input' && !element.disabled);
      if (!search || !(await page.widgetType(search.ref, segment)).ok) return false;

      for (let round = 0; round < SEARCH_RESULT_ROUNDS && !choice; round++) {
        ctx.budget.ensureRunning();
        await page.settle();
        view = await page.widgetView(field.id);
        if (!view) return false;
        choice = findChoice(view, segment);
      }
      if (!choice) return false;
    }

    if (!(await page.widgetClick(choice.ref)).ok) return false;
    await page.settle();
    view = await page.widgetView(field.id);
    if (!view) return false;
  }
  return verified(ctx, field, target);
}

async function execute(
  page: PageDriver,
  decision: Exclude<WidgetDecision, { action: 'done' } | { action: 'fail' }>
): Promise<ActionResult> {
  switch (decision.action) {
    case 'click':
      return page.widgetClick(decision.ref);
    case 'type':
      return page.widgetType(decision.ref, decision.text);
    case 'press':
      return page.widgetPress(decision.ref, decision.key);
  }
}

function describe(decision: WidgetDecision): string {
  switch (decision.action) {
    case 'click':
      return `click ${decision.ref}`;
    case 'type':
      return `type "${decision.text}" into ${decision.ref}`;
    case 'press':
      return `press ${decision.key} on ${decision.ref}`;
    default:
      return decision.action;
  }
}

async function runAgentLoop(
  ctx: WidgetContext,
  field: FieldView,
  target: string[]
): Promise<WidgetResult> {
  const { page, llm, budget, limits, signal, emit } = ctx;
  const history: string[] = [];
  const clickedTexts: string[] = [];
  let rejectedClaims = 0;

  /**
   * The plan's answer can paraphrase options it could not see ("remote" for
   * "WFH (100%)"). So "done" also holds if the field now shows what was clicked.
   */
  const claimHolds = async (): Promise<boolean> => {
    if (await verified(ctx, field, target)) return true;
    const reading = await page.readField(field.id);
    return clickedTexts.some((text) => displayMatches([text], reading.value));
  };

  for (let step = 1; step <= limits.maxWidgetSteps; step++) {
    budget.ensureCanCallModel();
    const view = await page.widgetView(field.id);
    if (!view) return { status: 'failed', detail: 'stale' };

    let decision: WidgetDecision;
    try {
      const response = await llm.widgetStep(
        { field: { label: field.label, hint: field.hint, widget: field.widget }, target, view, history },
        signal
      );
      budget.record(response.usage);
      decision = response.value;
    } catch (error) {
      // An unusable reply costs this field, not the whole run.
      if (error instanceof LlmError && (error.code === 'bad_response' || error.code === 'refused')) {
        return { status: 'failed', detail: 'model-error' };
      }
      throw error;
    }
    emit({ type: 'widget-step', fieldId: field.id, step, action: decision.action });

    if (decision.action === 'fail') {
      return { status: 'failed', detail: 'model-gave-up' };
    }

    if (decision.action === 'done') {
      if (await claimHolds()) return { status: 'filled' };
      const reading = await page.readField(field.id);
      if (++rejectedClaims > MAX_REJECTED_CLAIMS) {
        return reading.value.trim()
          ? { status: 'unconfirmed', detail: 'display-mismatch' }
          : { status: 'failed', detail: 'verify-failed' };
      }
      history.push(
        `You reported done, but the field shows "${reading.value}", not the target. Continue.`
      );
      continue;
    }

    const element = view.elements.find((candidate) => candidate.ref === decision.ref);
    if (!element) {
      history.push(`${describe(decision)} rejected: ${decision.ref} is not in the current view.`);
      continue;
    }

    const result = await execute(page, decision);
    if (result.ok && decision.action === 'click' && element.text) clickedTexts.push(element.text);
    history.push(
      result.ok ? `${describe(decision)}: ok` : `${describe(decision)}: failed (${result.code})`
    );
    await page.settle();

    // A selection shows up immediately; do not spend a turn asking about it.
    // Typing does not count: text in a search box is not a committed choice.
    if (result.ok && decision.action !== 'type' && (await verified(ctx, field, target))) {
      return { status: 'filled' };
    }
  }

  return (await verified(ctx, field, target))
    ? { status: 'filled' }
    : { status: 'failed', detail: 'step-limit' };
}

async function interact(ctx: WidgetContext, field: FieldView, target: string[]): Promise<WidgetResult> {
  try {
    const direct =
      field.widget === 'datepicker'
        ? await tryTypedDate(ctx, field, target)
        : await tryDirectPick(ctx, field, target);
    ctx.emit({ type: 'widget-direct', fieldId: field.id, ok: direct });
    if (direct) return { status: 'filled' };

    // The model's first move would be to open it; spare it the turn.
    await ensureOpen(ctx, field);
    return await runAgentLoop(ctx, field, target);
  } finally {
    await ctx.page.closeWidget(field.id);
  }
}

export async function fillWidget(
  ctx: WidgetContext,
  field: FieldView,
  target: string[]
): Promise<WidgetResult> {
  const before = (await ctx.page.readField(field.id)).value;
  const result = await interact(ctx, field, target);
  if (result.status !== 'filled') return result;

  // Closing can undo an uncommitted choice, so what counts is what remains after.
  const after = (await ctx.page.readField(field.id)).value;
  const undone = !after.trim()
    || (sameText(after, before) && !displayMatches(target, after, field.widget));
  return undone ? { status: 'failed', detail: 'reverted' } : result;
}
