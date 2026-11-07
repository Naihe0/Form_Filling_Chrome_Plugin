/**
 * Domain types shared by the harness, the page driver and the LLM tasks.
 *
 * These are the only things that cross the boundary between the page and the
 * model: the model sees FieldView (never raw HTML) and refers to fields and
 * options by id (never by CSS selector).
 */

export type FieldKind = 'text' | 'select' | 'radio' | 'checkbox' | 'widget';
export type WidgetHint = 'dropdown' | 'search' | 'datepicker' | 'cascader';
export type BlockReason = 'password' | 'payment' | 'otp' | 'captcha' | 'consent' | 'file';

export interface OptionView {
  id: string;
  label: string;
  selected: boolean;
}

export interface FieldView {
  id: string;
  kind: FieldKind;
  label: string;
  /** Nearest fieldset legend or heading. */
  section?: string;
  /** Placeholder, description, or other low-confidence naming hints. */
  hint?: string;
  required: boolean;
  /** Text subtype: email, tel, date, number, richtext, multiline... */
  inputType?: string;
  maxLength?: number;
  multiple?: boolean;
  widget?: WidgetHint;
  options?: OptionView[];
  /** The field already holds a value the user or the page put there. */
  filled: boolean;
  /** Set when policy forbids touching this field; never sent to the model. */
  blocked?: BlockReason;
}

export interface PageSnapshot {
  title: string;
  host: string;
  fields: FieldView[];
}

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Includes hidden thinking tokens, so it can far exceed prompt + completion. */
  totalTokens: number;
}

export const emptyUsage = (): Usage => ({
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

export type OutcomeStatus =
  | 'filled' // Written and read back equal to the answer.
  | 'unconfirmed' // Written, but the page does not let us prove it stuck.
  | 'skipped' // The profile has no answer.
  | 'prefilled' // Already had a value; left alone.
  | 'blocked' // Policy forbids it; the user must do it.
  | 'failed'; // Tried and could not make it stick.

export interface FieldOutcome {
  fieldId: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  status: OutcomeStatus;
  /** Machine-readable reason, e.g. no-profile-data, verify-failed, password. */
  detail?: string;
}

export type RunStatus = 'completed' | 'stopped' | 'failed' | 'budget-exhausted';

export interface RunError {
  code: string;
  message: string;
}

export interface RunReport {
  status: RunStatus;
  error?: RunError;
  outcomes: FieldOutcome[];
  usage: Usage;
  passes: number;
  durationMs: number;
}
