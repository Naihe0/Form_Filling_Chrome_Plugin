import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runFill } from '../../src/harness/runner.ts';
import type { WidgetElement, WidgetView } from '../../src/harness/types.ts';
import { LlmError } from '../../src/shared/errors.ts';
import type { RunReport } from '../../src/shared/types.ts';
import { FakePage, scriptedLlm, widgetField, type ScriptedLlm } from '../helpers/fake-page.ts';

/** A dropdown whose popup opens on trigger click and commits on option click. */
function dropdownPage(options: string[]) {
  let open = false;
  const trigger: WidgetElement = { ref: 'e0', role: 'combobox', text: 'Please choose', trigger: true };
  const items = options.map(
    (text, i): WidgetElement => ({ ref: `e${i + 1}`, role: 'option', text, popup: true })
  );

  const page = new FakePage([widgetField('f1', 'City')], {
    widgetView: (p): WidgetView => ({
      fieldId: 'f1',
      display: p.values.get('f1') ?? 'Please choose',
      open,
      elements: open ? [trigger, ...items] : [trigger],
      popupText: '',
    }),
    onWidgetClick: (p, ref) => {
      if (ref === 'e0') open = true;
      else {
        const item = items.find((element) => element.ref === ref);
        if (item) {
          p.values.set('f1', item.text);
          open = false;
        }
      }
      return { ok: true };
    },
  });
  return page;
}

function run(page: FakePage, llm: ScriptedLlm, maxWidgetSteps = 10): Promise<RunReport> {
  return runFill({
    page,
    llm,
    signal: new AbortController().signal,
    options: { overwrite: false },
    limits: { maxWidgetSteps },
  });
}

const outcome = (report: RunReport) => report.outcomes[0];

describe('widgets: deterministic pick', () => {
  it('fills a plain dropdown with no extra model calls', async () => {
    const page = dropdownPage(['Beijing', 'Shanghai']);
    const llm = scriptedLlm([[{ field: 'f1', answer: ['Shanghai'] }]]);

    const report = await run(page, llm);

    assert.equal(outcome(report).status, 'filled');
    assert.equal(llm.widgetRequests.length, 0);
    assert.equal(report.usage.calls, 1);
    assert.deepEqual(page.log, ['click e0', 'click e2', 'close f1']);
  });

  it('does not pick the wrong option by substring', async () => {
    const page = dropdownPage(['同意', '不同意']);
    const llm = scriptedLlm([[{ field: 'f1', answer: ['不同意'] }]]);

    await run(page, llm);

    assert.equal(page.values.get('f1'), '不同意');
  });

  it('always closes the widget afterwards', async () => {
    const page = dropdownPage(['A']);
    await run(page, scriptedLlm([[{ field: 'f1', answer: ['A'] }]]));
    assert.equal(page.log.at(-1), 'close f1');
  });
});

describe('widgets: the model-driven loop', () => {
  it('hands over to the model when the option is not visible', async () => {
    const page = dropdownPage(['Beijing']);
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Shanghai'] }]],
      [{ action: 'fail', reason: 'Shanghai is not offered' }]
    );

    const report = await run(page, llm);

    assert.equal(llm.widgetRequests.length, 1);
    assert.equal(outcome(report).status, 'failed');
    assert.equal(outcome(report).detail, 'model-gave-up');
  });

  it('rejects a false "done" claim by reading the field back', async () => {
    const page = dropdownPage(['Beijing']);
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Shanghai'] }]],
      [{ action: 'done' }, { action: 'done' }, { action: 'done' }]
    );

    const report = await run(page, llm);

    assert.notEqual(outcome(report).status, 'filled');
    assert.match(llm.widgetRequests[1].history[0], /You reported done/);
    assert.equal(llm.widgetRequests.length, 3);
  });

  it('refuses refs that are not in the current view', async () => {
    const page = dropdownPage(['Beijing']);
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Shanghai'] }]],
      [{ action: 'click', ref: 'e99' }, { action: 'fail', reason: 'gave up' }]
    );

    await run(page, llm);

    assert.ok(!page.log.includes('click e99'));
    assert.match(llm.widgetRequests[1].history[0], /not in the current view/);
  });

  it('reports the step limit rather than looping', async () => {
    const page = dropdownPage(['Beijing']);
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Shanghai'] }]],
      [
        { action: 'click', ref: 'e0' },
        { action: 'click', ref: 'e0' },
      ]
    );

    const report = await run(page, llm, 2);

    assert.equal(outcome(report).status, 'failed');
    assert.equal(outcome(report).detail, 'step-limit');
  });

  it('finishes without asking again once a click shows the target', async () => {
    let shown = '';
    const elements: WidgetElement[] = [
      { ref: 'e0', role: 'combobox', text: '', trigger: true },
      { ref: 'e1', role: 'cell', text: 'odd label', popup: true },
    ];
    const page = new FakePage([widgetField('f1', 'Thing')], {
      widgetView: (): WidgetView => ({ fieldId: 'f1', display: shown, open: true, elements, popupText: '' }),
      onWidgetClick: (p, ref) => {
        if (ref === 'e1') {
          shown = 'Target';
          p.values.set('f1', 'Target');
        }
        return { ok: true };
      },
    });
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Target'] }]],
      [{ action: 'click', ref: 'e1' }]
    );

    const report = await run(page, llm);

    assert.equal(outcome(report).status, 'filled');
    assert.equal(llm.widgetRequests.length, 1);
  });

  it('does not treat typed search text as a committed choice', async () => {
    const elements: WidgetElement[] = [
      { ref: 'e0', role: 'input', text: '', trigger: true },
    ];
    const page = new FakePage([widgetField('f1', 'City', { widget: 'search' })], {
      widgetView: (p): WidgetView => ({
        fieldId: 'f1',
        display: p.values.get('f1') ?? '',
        open: false,
        elements,
        popupText: '',
      }),
    });
    const originalType = page.widgetType.bind(page);
    page.widgetType = async (ref, text) => {
      page.values.set('f1', text);
      return originalType(ref, text);
    };
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Shanghai'] }]],
      [
        { action: 'type', ref: 'e0', text: 'Shanghai' },
        { action: 'done' },
      ]
    );

    const report = await run(page, llm);

    // The direct pick types but cannot commit, so the model is asked; only its
    // explicit "done" plus a matching read-back ends the widget.
    assert.equal(llm.widgetRequests.length, 2);
    assert.equal(outcome(report).status, 'filled');
  });

  it('costs one field, not the run, when the model reply is unusable', async () => {
    const page = dropdownPage(['Beijing']);
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Shanghai'] }]],
      [new LlmError('bad_response', 'garbage')]
    );

    const report = await run(page, llm);

    assert.equal(report.status, 'completed');
    assert.equal(outcome(report).detail, 'model-error');
  });

  it('ends the run on an authentication failure', async () => {
    const page = dropdownPage(['Beijing']);
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['Shanghai'] }]],
      [new LlmError('auth', 'HTTP 401')]
    );

    const report = await run(page, llm);

    assert.equal(report.status, 'failed');
    assert.equal(report.error?.code, 'auth');
    assert.equal(page.log.at(-1), 'close f1');
  });
});

describe('widgets: what remains after closing', () => {
  it('fails a widget that undoes the choice when it closes', async () => {
    const page = dropdownPage(['Beijing', 'Shanghai']);
    const close = page.closeWidget.bind(page);
    page.closeWidget = async (fieldId) => {
      page.values.delete('f1');
      await close(fieldId);
    };
    const original = page.hooks.widgetView!;
    page.hooks.widgetView = (p, id) => ({ ...original(p, id)!, display: p.values.get('f1') ?? '' });

    const report = await run(page, scriptedLlm([[{ field: 'f1', answer: ['Shanghai'] }]]));

    assert.equal(outcome(report).status, 'failed');
    assert.equal(outcome(report).detail, 'reverted');
  });

  it('does not count re-selecting the existing value as undone', async () => {
    const page = dropdownPage(['Beijing', 'Shanghai']);
    page.values.set('f1', 'Shanghai');
    page.fields[0].filled = true;

    const report = await runFill({
      page,
      llm: scriptedLlm([[{ field: 'f1', answer: ['Shanghai'] }]]),
      signal: new AbortController().signal,
      options: { overwrite: true },
    });

    assert.equal(outcome(report).status, 'filled');
  });
});

describe('widgets: cascaders and dates', () => {
  it('walks a cascader path level by level', async () => {
    const levels: Record<string, string[]> = {
      root: ['广东省', '浙江省'],
      广东省: ['深圳市', '广州市'],
      深圳市: ['南山区', '福田区'],
    };
    let level = 'root';
    let open = false;
    let display = '';
    const page = new FakePage([widgetField('f1', '地区', { widget: 'cascader' })], {
      widgetView: (): WidgetView => ({
        fieldId: 'f1',
        display,
        open,
        elements: [
          { ref: 'e0', role: 'combobox', text: display, trigger: true },
          ...(open
            ? (levels[level] ?? []).map(
                (text): WidgetElement => ({ ref: `opt:${text}`, role: 'option', text, popup: true })
              )
            : []),
        ],
        popupText: '',
      }),
      onWidgetClick: (p, ref) => {
        if (ref === 'e0') open = true;
        else {
          const text = ref.replace('opt:', '');
          if (levels[text]) level = text;
          else {
            display = text;
            p.values.set('f1', text);
            open = false;
          }
        }
        return { ok: true };
      },
    });
    const llm = scriptedLlm([[{ field: 'f1', answer: ['广东省', '深圳市', '南山区'] }]]);

    const report = await run(page, llm);

    assert.equal(outcome(report).status, 'filled');
    assert.equal(llm.widgetRequests.length, 0);
    assert.deepEqual(page.log, ['click e0', 'click opt:广东省', 'click opt:深圳市', 'click opt:南山区', 'close f1']);
  });

  it('types a date when the picker accepts typing', async () => {
    const page = new FakePage([widgetField('f1', 'Date', { widget: 'datepicker' })], {
      widgetView: (p): WidgetView => ({
        fieldId: 'f1',
        display: p.values.get('f1') ?? '',
        open: false,
        elements: [{ ref: 'e0', role: 'input', text: '', trigger: true }],
        popupText: '',
      }),
    });
    const originalType = page.widgetType.bind(page);
    page.widgetType = async (ref, text) => {
      page.values.set('f1', text);
      return originalType(ref, text);
    };
    const llm = scriptedLlm([[{ field: 'f1', answer: ['2024-03-15'] }]]);

    const report = await run(page, llm);

    assert.equal(outcome(report).status, 'filled');
    assert.equal(llm.widgetRequests.length, 0);
    assert.ok(page.log.includes('press e0=Enter'));
  });

  it('finds the input inside a wrapper trigger, as Ant Design renders it', async () => {
    const page = new FakePage([widgetField('f1', 'Date', { widget: 'datepicker' })], {
      widgetView: (p): WidgetView => ({
        fieldId: 'f1',
        display: p.values.get('f1') ?? '',
        open: false,
        elements: [
          { ref: 'e0', role: 'item', text: '', trigger: true },
          { ref: 'e1', role: 'input', text: '' },
        ],
        popupText: '',
      }),
    });
    const originalType = page.widgetType.bind(page);
    page.widgetType = async (ref, text) => {
      page.values.set('f1', text);
      return originalType(ref, text);
    };
    const llm = scriptedLlm([[{ field: 'f1', answer: ['2024-03-15'] }]]);

    const report = await run(page, llm);

    assert.equal(outcome(report).status, 'filled');
    assert.equal(llm.widgetRequests.length, 0);
    assert.ok(page.log.includes('type e1=2024-03-15'));
  });

  it('does not trust typed text a picker rejects on closing', async () => {
    const page = new FakePage([widgetField('f1', 'Date', { widget: 'datepicker' })], {
      widgetView: (p): WidgetView => ({
        fieldId: 'f1',
        display: p.values.get('f1') ?? '',
        open: false,
        elements: [{ ref: 'e0', role: 'input', text: '', trigger: true }],
        popupText: '',
      }),
    });
    page.widgetType = async (_ref, text) => {
      page.values.set('f1', text);
      return { ok: true };
    };
    const close = page.closeWidget.bind(page);
    page.closeWidget = async (fieldId) => {
      page.values.delete('f1');
      await close(fieldId);
    };
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['2024-03-15'] }]],
      [{ action: 'fail', reason: 'picker will not accept it' }]
    );

    const report = await run(page, llm);

    assert.equal(llm.widgetRequests.length, 1, 'the model should have been asked');
    assert.equal(outcome(report).status, 'failed');
  });

  it('falls back to the model when the picker is read-only', async () => {
    const page = new FakePage([widgetField('f1', 'Date', { widget: 'datepicker' })], {
      widgetView: (p): WidgetView => ({
        fieldId: 'f1',
        display: p.values.get('f1') ?? '',
        open: true,
        elements: [
          { ref: 'e0', role: 'button', text: 'Pick', trigger: true },
          { ref: 'e15', role: 'cell', text: '15', popup: true },
        ],
        popupText: 'March 2024',
      }),
      onWidgetClick: (p, ref) => {
        if (ref === 'e15') p.values.set('f1', '03/15/2024');
        return { ok: true };
      },
    });
    const llm = scriptedLlm(
      [[{ field: 'f1', answer: ['2024-03-15'] }]],
      [{ action: 'click', ref: 'e15' }]
    );

    const report = await run(page, llm);

    assert.equal(outcome(report).status, 'filled');
    assert.equal(llm.widgetRequests[0].view.popupText, 'March 2024');
  });
});
