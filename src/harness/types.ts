/**
 * The harness's two ports. Everything it knows about the world comes through
 * PageDriver and LlmClient, so the same run loop executes against a fake page
 * in unit tests, a real DOM in the browser, and a scripted or live model.
 */
import type { FieldOutcome, FieldView, PageSnapshot, RunReport, Usage } from '../shared/types.ts';

export type ActionCode = 'stale' | 'forbidden' | 'readonly' | 'not-found' | 'rejected';

export type ActionResult = { ok: true } | { ok: false; code: ActionCode; detail?: string };

export interface FieldReading {
  exists: boolean;
  /** Current text or display value. */
  value: string;
  /** Selected option ids, or null when the page exposes no reliable state. */
  selected: string[] | null;
}

export interface WidgetElement {
  ref: string;
  role: string;
  text: string;
  disabled?: boolean;
  selected?: boolean;
  /** The field's own trigger element. */
  trigger?: boolean;
  /** Lives in a popup opened for this widget, rather than in the field itself. */
  popup?: boolean;
  /** Current value when the element is a text input. */
  value?: string;
}

export interface WidgetView {
  fieldId: string;
  /** What the widget currently shows the user. */
  display: string;
  open: boolean;
  elements: WidgetElement[];
  /** Non-interactive popup text, e.g. a calendar's month heading. */
  popupText: string;
}

export type MarkStatus = 'working' | 'filled' | 'attention' | 'clear';

export interface PageDriver {
  snapshot(): Promise<PageSnapshot>;
  fillText(fieldId: string, text: string): Promise<ActionResult>;
  selectOptions(fieldId: string, optionIds: string[]): Promise<ActionResult>;
  readField(fieldId: string): Promise<FieldReading>;

  widgetView(fieldId: string): Promise<WidgetView | null>;
  widgetClick(ref: string): Promise<ActionResult>;
  widgetType(ref: string, text: string): Promise<ActionResult>;
  widgetPress(ref: string, key: string): Promise<ActionResult>;
  /** Dismisses any popup left open and stops tracking the widget. */
  closeWidget(fieldId: string): Promise<void>;

  /** Resolves once the DOM has stopped changing, or after a short cap. */
  settle(): Promise<void>;
  mark(fieldId: string, status: MarkStatus): void;
}

/* ------------------------------------------------------------------ */
/* Model port                                                          */
/* ------------------------------------------------------------------ */

export interface RawAnswer {
  field: string;
  answer: string[];
}

export interface PlanRequest {
  host: string;
  title: string;
  fields: FieldView[];
  /** Validation errors from the previous attempt, for a one-shot repair. */
  feedback?: string;
}

export type WidgetDecision =
  | { action: 'click'; ref: string }
  | { action: 'type'; ref: string; text: string }
  | { action: 'press'; ref: string; key: string }
  | { action: 'done' }
  | { action: 'fail'; reason: string };

export interface WidgetStepRequest {
  field: Pick<FieldView, 'label' | 'hint' | 'widget'>;
  target: string[];
  view: WidgetView;
  history: string[];
}

export interface TaskResponse<T> {
  value: T;
  usage: Usage;
}

export interface LlmClient {
  plan(request: PlanRequest, signal: AbortSignal): Promise<TaskResponse<RawAnswer[]>>;
  widgetStep(request: WidgetStepRequest, signal: AbortSignal): Promise<TaskResponse<WidgetDecision>>;
}

/* ------------------------------------------------------------------ */
/* Run events                                                          */
/* ------------------------------------------------------------------ */

/** The trace of a run. Carries labels and statuses, never answer values. */
export type RunEvent =
  | { type: 'snapshot'; pass: number; total: number; pending: number; blocked: number }
  | { type: 'plan-start'; pass: number; fields: number }
  | { type: 'plan-done'; answered: number; invalid: number; usage: Usage }
  | { type: 'field-start'; fieldId: string; label: string; done: number; total: number }
  | { type: 'widget-direct'; fieldId: string; ok: boolean }
  | { type: 'widget-step'; fieldId: string; step: number; action: string }
  | { type: 'field-done'; outcome: FieldOutcome; done: number; total: number }
  | { type: 'audit'; checked: number; reverted: number }
  | { type: 'run-end'; report: RunReport };

export interface RunOptions {
  /** Also rewrite fields that already hold a value. */
  overwrite: boolean;
}
