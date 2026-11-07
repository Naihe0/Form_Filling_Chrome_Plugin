/**
 * An in-memory PageDriver plus a scripted LlmClient, so the run loop can be
 * exercised without a browser. Behaviour hooks simulate the pages that make
 * form filling hard: controls that reject writes, fields revealed by answers,
 * frameworks that reset earlier fields.
 */
import type {
  ActionResult,
  FieldReading,
  LlmClient,
  MarkStatus,
  PageDriver,
  PlanRequest,
  RawAnswer,
  WidgetDecision,
  WidgetStepRequest,
  WidgetView,
} from '../../src/harness/types.ts';
import { emptyUsage, type FieldView, type PageSnapshot, type Usage } from '../../src/shared/types.ts';

export interface FakePageHooks {
  onFill?: (page: FakePage, fieldId: string, text: string) => ActionResult | void;
  onSelect?: (page: FakePage, fieldId: string, optionIds: string[]) => ActionResult | void;
  onWidgetClick?: (page: FakePage, ref: string) => ActionResult | void;
  widgetView?: (page: FakePage, fieldId: string) => WidgetView | null;
}

export class FakePage implements PageDriver {
  fields: FieldView[];
  values = new Map<string, string>();
  selected = new Map<string, string[] | null>();
  log: string[] = [];
  marks = new Map<string, MarkStatus>();
  hooks: FakePageHooks;

  constructor(fields: FieldView[], hooks: FakePageHooks = {}) {
    this.fields = fields;
    this.hooks = hooks;
  }

  async snapshot(): Promise<PageSnapshot> {
    return { title: 'Test form', host: 'example.test', fields: this.fields.map((f) => ({ ...f })) };
  }

  async fillText(fieldId: string, text: string): Promise<ActionResult> {
    this.log.push(`fill ${fieldId}=${text}`);
    const override = this.hooks.onFill?.(this, fieldId, text);
    if (override) return override;
    this.values.set(fieldId, text);
    return { ok: true };
  }

  async selectOptions(fieldId: string, optionIds: string[]): Promise<ActionResult> {
    this.log.push(`select ${fieldId}=${optionIds.join(',')}`);
    const override = this.hooks.onSelect?.(this, fieldId, optionIds);
    if (override) return override;
    this.selected.set(fieldId, optionIds);
    return { ok: true };
  }

  async readField(fieldId: string): Promise<FieldReading> {
    const exists = this.fields.some((field) => field.id === fieldId);
    return {
      exists,
      value: this.values.get(fieldId) ?? '',
      selected: this.selected.has(fieldId) ? this.selected.get(fieldId)! : [],
    };
  }

  async widgetView(fieldId: string): Promise<WidgetView | null> {
    return this.hooks.widgetView?.(this, fieldId) ?? null;
  }

  async widgetClick(ref: string): Promise<ActionResult> {
    this.log.push(`click ${ref}`);
    return this.hooks.onWidgetClick?.(this, ref) ?? { ok: true };
  }

  async widgetType(ref: string, text: string): Promise<ActionResult> {
    this.log.push(`type ${ref}=${text}`);
    return { ok: true };
  }

  async widgetPress(ref: string, key: string): Promise<ActionResult> {
    this.log.push(`press ${ref}=${key}`);
    return { ok: true };
  }

  async closeWidget(fieldId: string): Promise<void> {
    this.log.push(`close ${fieldId}`);
  }

  async settle(): Promise<void> {}

  mark(fieldId: string, status: MarkStatus): void {
    this.marks.set(fieldId, status);
  }
}

export function textField(id: string, label: string, extra: Partial<FieldView> = {}): FieldView {
  return { id, kind: 'text', label, required: false, filled: false, ...extra };
}

export function radioField(id: string, label: string, options: Record<string, string>): FieldView {
  return {
    id,
    kind: 'radio',
    label,
    required: false,
    filled: false,
    options: Object.entries(options).map(([optionId, text]) => ({
      id: optionId,
      label: text,
      selected: false,
    })),
  };
}

export function widgetField(id: string, label: string, extra: Partial<FieldView> = {}): FieldView {
  return { id, kind: 'widget', label, required: false, filled: false, widget: 'dropdown', ...extra };
}

const USAGE: Usage = { ...emptyUsage(), calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15 };

export interface ScriptedLlm extends LlmClient {
  planRequests: PlanRequest[];
  widgetRequests: WidgetStepRequest[];
}

/** Replies from queues; an Error in a queue is thrown. Running dry fails the test. */
export function scriptedLlm(
  plans: Array<RawAnswer[] | Error>,
  widgetSteps: Array<WidgetDecision | Error> = []
): ScriptedLlm {
  const planRequests: PlanRequest[] = [];
  const widgetRequests: WidgetStepRequest[] = [];
  return {
    planRequests,
    widgetRequests,
    async plan(request) {
      planRequests.push(request);
      const next = plans.shift();
      if (!next) throw new Error('Unexpected plan call: script is empty.');
      if (next instanceof Error) throw next;
      return { value: next, usage: { ...USAGE } };
    },
    async widgetStep(request) {
      widgetRequests.push(request);
      const next = widgetSteps.shift();
      if (!next) throw new Error('Unexpected widget call: script is empty.');
      if (next instanceof Error) throw next;
      return { value: next, usage: { ...USAGE } };
    },
  };
}
