/**
 * Validates the model's plan against the snapshot and resolves each answer
 * into an action the driver can execute. Anything the model invents (unknown
 * ids, non-options, runaway text) stops here instead of reaching the page.
 */
import type { FieldView } from '../shared/types.ts';
import { findOptionIndex } from './match.ts';
import type { RawAnswer } from './types.ts';

export type ResolvedAnswer =
  | { kind: 'text'; text: string }
  | { kind: 'options'; optionIds: string[] }
  | { kind: 'path'; path: string[] }
  | { kind: 'none' };

export interface Resolution {
  answers: Map<string, ResolvedAnswer>;
  /** Field id to error description, for the repair round. */
  errors: Map<string, string>;
}

/** Placeholders models emit despite instructions to answer with an empty list. */
const NON_ANSWERS = new Set(['', 'null', 'none', 'undefined', 'n/a', 'na', 'unknown', '未知', '不详']);

/** A single-line input holds one short value; longer text suggests an injected dump. */
const MAX_SINGLE_LINE_CHARS = 500;

const isMultiline = (field: FieldView) =>
  field.inputType === 'multiline' || field.inputType === 'richtext';

function resolveOne(field: FieldView, values: string[]): ResolvedAnswer | string {
  switch (field.kind) {
    case 'text': {
      const text = values.join(', ');
      if (!isMultiline(field) && text.length > MAX_SINGLE_LINE_CHARS) {
        return `"${field.id}" is a single-line field; the answer is too long.`;
      }
      return { kind: 'text', text };
    }

    case 'widget':
      return { kind: 'path', path: values };

    case 'select':
    case 'radio':
    case 'checkbox': {
      const options = field.options ?? [];
      const labels = options.map((option) => option.label);
      const optionIds: string[] = [];

      for (const value of values) {
        const byId = options.find((option) => option.id === value);
        const index = byId ? -1 : findOptionIndex(labels, value);
        const id = byId?.id ?? options[index]?.id;
        if (!id) return `"${value}" is not an option of "${field.id}".`;
        if (!optionIds.includes(id)) optionIds.push(id);
      }

      const single = field.kind === 'radio' || (field.kind === 'select' && !field.multiple);
      if (single && optionIds.length > 1) {
        return `"${field.id}" accepts exactly one option, got ${optionIds.length}.`;
      }
      return { kind: 'options', optionIds };
    }
  }
}

export function resolveAnswers(fields: FieldView[], raw: RawAnswer[]): Resolution {
  const byField = new Map(raw.map((entry) => [entry.field, entry.answer]));
  const answers = new Map<string, ResolvedAnswer>();
  const errors = new Map<string, string>();

  for (const field of fields) {
    const values = (byField.get(field.id) ?? [])
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => !NON_ANSWERS.has(value.toLowerCase()));

    if (values.length === 0) {
      answers.set(field.id, { kind: 'none' });
      continue;
    }

    const resolved = resolveOne(field, values);
    if (typeof resolved === 'string') errors.set(field.id, resolved);
    else answers.set(field.id, resolved);
  }
  return { answers, errors };
}
