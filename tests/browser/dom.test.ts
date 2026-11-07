/**
 * The page driver against real pages in real Chromium, with no model involved.
 * Perception and execution must be right on their own; a scripted "oracle"
 * stands in for the model and answers by field label.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { LlmClient, RawAnswer, WidgetDecision } from '../../src/harness/types.ts';
import { emptyUsage, type FieldView, type RunReport } from '../../src/shared/types.ts';
import { exposeLlm, injectDriver, runIn, serveFixtures, snapshotOf, type FixtureServer } from '../helpers/browser.ts';

let browser: Browser;
let fixtures: FixtureServer;

before(async () => {
  fixtures = await serveFixtures();
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await fixtures.close();
});

/** Answers by matching field labels; option answers may be given by their text. */
function oracle(rules: Array<[RegExp, string[]]>, widgetSteps: WidgetDecision[] = []) {
  const planned: FieldView[][] = [];
  const widgetCalls: unknown[] = [];
  const usage = { ...emptyUsage(), calls: 1, totalTokens: 1 };
  const client: LlmClient = {
    async plan(request) {
      planned.push(request.fields);
      const value: RawAnswer[] = request.fields.map((field) => {
        const rule = rules.find(([pattern]) => pattern.test(field.label));
        return { field: field.id, answer: rule ? rule[1] : [] };
      });
      return { value, usage };
    },
    async widgetStep(request) {
      widgetCalls.push(request);
      return { value: widgetSteps.shift() ?? { action: 'fail', reason: 'script empty' }, usage };
    },
  };
  return { client, planned, widgetCalls };
}

async function open(path: string, client?: LlmClient): Promise<Page> {
  const page = await browser.newPage();
  if (client) await exposeLlm(page, client);
  await page.goto(fixtures.url(path));
  await injectDriver(page);
  return page;
}

const find = (fields: FieldView[], pattern: RegExp) => {
  const field = fields.find((candidate) => pattern.test(candidate.label));
  assert.ok(field, `no field matching ${pattern} in: ${fields.map((f) => f.label).join(' | ')}`);
  return field;
};

const statusOf = (report: RunReport, pattern: RegExp) => {
  const outcome = report.outcomes.find((candidate) => pattern.test(candidate.label));
  assert.ok(outcome, `no outcome matching ${pattern}`);
  return outcome;
};

describe('scan: naming and classifying native controls', () => {
  let fields: FieldView[];

  before(async () => {
    const page = await open('contact.html');
    fields = await snapshotOf(page);
    await page.close();
  });

  it('names fields from every labelling style', () => {
    assert.equal(find(fields, /^Full name/).required, true);
    assert.equal(find(fields, /^Email$/).inputType, 'email');
    assert.equal(find(fields, /^Phone number$/).inputType, 'tel');
    assert.equal(find(fields, /^Date of birth$/).inputType, 'date');
    assert.equal(find(fields, /^Years of experience$/).inputType, 'number');
    assert.equal(find(fields, /^Personal website$/).inputType, 'url');
  });

  it('strips required markers from labels', () => {
    assert.ok(fields.some((field) => field.label === 'Full name'));
  });

  it('groups radios and checkboxes under their legend', () => {
    const gender = find(fields, /^Gender$/);
    assert.equal(gender.kind, 'radio');
    assert.deepEqual(gender.options?.map((option) => option.label), ['Male', 'Female', 'Prefer not to say']);

    const skills = find(fields, /^Programming languages$/);
    assert.equal(skills.kind, 'checkbox');
    assert.equal(skills.multiple, true);
    assert.equal(skills.options?.length, 4);
  });

  it('drops a select placeholder from the options', () => {
    const education = find(fields, /^Highest education$/);
    assert.equal(education.kind, 'select');
    assert.equal(education.options?.length, 4);
    assert.equal(education.filled, false);
  });

  it('recognises a prefilled field', () => {
    assert.equal(find(fields, /^Nickname$/).filled, true);
    assert.equal(find(fields, /^Full name$/).filled, false);
  });

  it('tags sensitive fields as blocked', () => {
    assert.equal(find(fields, /password/i).blocked, 'password');
    assert.equal(find(fields, /card number/i).blocked, 'payment');
    assert.equal(find(fields, /terms of service/i).blocked, 'consent');
    assert.equal(find(fields, /resume/i).blocked, 'file');
  });

  it('ignores what a person cannot reach', () => {
    const labels = fields.map((field) => field.label).join('|');
    assert.ok(!/leave this empty/i.test(labels), labels);
    assert.ok(!/confirm email/i.test(labels), labels);
    assert.ok(!/hp[ _]/i.test(labels), labels);
    assert.ok(!/csrf/i.test(JSON.stringify(fields)), 'a hidden token reached the snapshot');
  });

  it('ignores the site search box', () => {
    assert.ok(!fields.some((field) => /search/i.test(field.label)));
  });

  it('never exposes hidden values', () => {
    assert.ok(!JSON.stringify(fields).includes('CSRF-SECRET-VALUE'));
  });

  it('keeps ids stable across scans', async () => {
    const page = await open('contact.html');
    const first = await snapshotOf(page);
    const second = await snapshotOf(page);
    assert.deepEqual(first.map((field) => field.id), second.map((field) => field.id));
    await page.close();
  });
});

describe('scan: surveys built without semantics', () => {
  let fields: FieldView[];

  before(async () => {
    const page = await open('survey-cn.html');
    fields = await snapshotOf(page);
    await page.close();
  });

  it('finds native radios hidden behind a styled proxy', () => {
    const gender = find(fields, /您的性别/);
    assert.equal(gender.kind, 'radio');
    assert.equal(gender.required, true);
    assert.deepEqual(gender.options?.map((option) => option.label), ['男', '女']);
  });

  it('keeps options whose text contains each other separate', () => {
    assert.deepEqual(find(fields, /是否吸烟/).options?.map((o) => o.label), ['吸烟', '不吸烟']);
  });

  it('finds multi-choice groups made of plain divs', () => {
    const languages = find(fields, /编程语言/);
    assert.equal(languages.kind, 'checkbox');
    assert.deepEqual(languages.options?.map((o) => o.label), ['JavaScript', 'Python', 'Go', 'Rust']);
  });

  it('finds single-choice groups made of list items', () => {
    const degree = find(fields, /最高学历/);
    assert.equal(degree.kind, 'radio');
    assert.deepEqual(degree.options?.map((o) => o.label), ['本科', '硕士', '博士']);
  });

  it('reads matrix questions from row and column headers', () => {
    const python = find(fields, /熟练程度: Python/);
    assert.equal(python.kind, 'radio');
    assert.deepEqual(python.options?.map((o) => o.label), ['不熟悉', '一般', '精通']);
    find(fields, /熟练程度: COBOL/);
  });

  it('labels fields from the text above them', () => {
    assert.equal(find(fields, /您所在的城市/).kind, 'select');
    assert.equal(find(fields, /介绍您目前的工作/).inputType, 'multiline');
    assert.equal(find(fields, /您的血型/).kind, 'text');
  });

  it('never offers the submit button as an option', () => {
    assert.ok(!JSON.stringify(fields).includes('提交'));
  });
});

describe('execution: native forms', () => {
  it('fills every kind of native control and verifies it', async () => {
    const { client } = oracle([
      [/^Full name$/, ['Wei Lin']],
      [/^Email$/, ['wei@example.com']],
      [/^Phone number$/, ['13800138000']],
      [/^Date of birth$/, ['1995年9月2日']],
      [/^Years of experience$/, ['6年']],
      [/^Personal website$/, ['https://lin.example.com']],
      [/^Gender$/, ['Female']],
      [/^Highest education$/, ["Master's degree"]],
      [/^Programming languages$/, ['JavaScript', 'Go']],
      [/^Why do you want/, ['Because it is interesting.']],
    ]);
    const page = await open('contact.html', client);

    const { report } = await runIn(page);

    assert.equal(report.status, 'completed');
    const value = (name: string) => page.locator(`[name="${name}"]`).inputValue();
    assert.equal(await value('fullName'), 'Wei Lin');
    assert.equal(await value('dob'), '1995-09-02');
    assert.equal(await value('years'), '6');
    assert.equal(await value('education'), 'ma');
    assert.equal(await page.locator('input[name="gender"][value="f"]').isChecked(), true);
    assert.equal(await page.locator('input[name="skills"][value="js"]').isChecked(), true);
    assert.equal(await page.locator('input[name="skills"][value="go"]').isChecked(), true);
    assert.equal(await page.locator('input[name="skills"][value="py"]').isChecked(), false);

    for (const outcome of report.outcomes.filter((o) => o.status !== 'blocked' && o.status !== 'prefilled')) {
      assert.equal(outcome.status, 'filled', `${outcome.label}: ${outcome.detail}`);
    }
    await page.close();
  });

  it('leaves prefilled values alone by default', async () => {
    const { client } = oracle([[/^Nickname$/, ['Should not appear']]]);
    const page = await open('contact.html', client);

    const { report } = await runIn(page);

    assert.equal(await page.locator('[name="nickname"]').inputValue(), 'Existing value');
    assert.equal(statusOf(report, /^Nickname$/).status, 'prefilled');
    await page.close();
  });

  it('overwrites prefilled values when asked', async () => {
    const { client } = oracle([[/^Nickname$/, ['New']]]);
    const page = await open('contact.html', client);

    await runIn(page, { overwrite: true });

    assert.equal(await page.locator('[name="nickname"]').inputValue(), 'New');
    await page.close();
  });

  it('never fills a blocked field, and never submits', async () => {
    const { client, planned } = oracle([[/./, ['hunter2']]]);
    const page = await open('contact.html', client);

    await runIn(page);

    assert.equal(await page.locator('[name="password"]').inputValue(), '');
    assert.equal(await page.locator('[name="cardnum"]').inputValue(), '');
    assert.equal(await page.locator('[name="tos"]').isChecked(), false);
    for (const trap of ['hp_offscreen', 'hp_display', 'hp_collapsed', 'hp_transparent']) {
      assert.equal(await page.locator(`[name="${trap}"]`).inputValue(), '', trap);
    }
    assert.equal(await page.evaluate(() => (window as any).__submitted), undefined);
    const offered = planned.flat().map((field) => field.label).join('|');
    assert.ok(!/password|card number|terms/i.test(offered), offered);
    await page.close();
  });

  it('refuses a blocked field at the driver, even if asked directly', async () => {
    const page = await open('contact.html');
    const result = await page.evaluate(async () => {
      const { fields } = await window.__aff.driver.snapshot();
      const password = fields.find((field) => field.blocked === 'password')!;
      return window.__aff.driver.fillText(password.id, 'hunter2');
    });
    assert.deepEqual(result, { ok: false, code: 'forbidden', detail: 'password' });
    assert.equal(await page.locator('[name="password"]').inputValue(), '');
    await page.close();
  });
});

describe('execution: hand-rolled surveys', () => {
  it('fills hidden radios, plain-div options and list items', async () => {
    const { client } = oracle([
      [/性别/, ['女']],
      [/吸烟/, ['不吸烟']],
      [/编程语言/, ['JavaScript', 'Go']],
      [/最高学历/, ['硕士']],
      [/熟练程度: Python/, ['精通']],
      [/城市/, ['深圳']],
      [/介绍/, ['软件工程师']],
    ]);
    const page = await open('survey-cn.html', client);

    const { report } = await runIn(page);

    const checked = (name: string, value: string) =>
      page.locator(`input[name="${name}"][value="${value}"]`).isChecked();
    assert.equal(await checked('q1', '2'), true);
    assert.equal(await checked('q2', '2'), true, 'chose 吸烟 instead of 不吸烟');
    assert.equal(await checked('q2', '1'), false);
    assert.equal(await checked('m1', '3'), true);
    assert.equal(await page.locator('.ui-radio.checked .label').first().textContent(), '女');

    const chosen = await page.locator('.option-item.is-checked').allTextContents();
    assert.deepEqual(chosen, ['JavaScript', 'Go']);
    assert.deepEqual(await page.locator('li.choice.selected').allTextContents(), ['硕士']);
    assert.equal(await page.locator('select[name="city"]').inputValue(), 'sz');

    assert.equal(statusOf(report, /吸烟/).status, 'filled');
    assert.equal(statusOf(report, /编程语言/).status, 'filled');
    assert.equal(statusOf(report, /血型/).status, 'skipped');
    assert.equal(statusOf(report, /COBOL/).status, 'skipped');
    assert.equal(await page.evaluate(() => (window as any).__submitted), false);
    await page.close();
  });

  it('does not toggle off an option that is already chosen', async () => {
    const { client } = oracle([[/编程语言/, ['Go']]]);
    const page = await open('survey-cn.html', client);
    await page.locator('.option-item', { hasText: 'Go' }).click();

    await runIn(page, { overwrite: true });

    assert.deepEqual(await page.locator('.option-item.is-checked').allTextContents(), ['Go']);
    await page.close();
  });
});

describe('execution: custom widgets', () => {
  it('fills a portalled dropdown with no widget model calls', async () => {
    const { client, widgetCalls } = oracle([[/工作城市/, ['上海']]]);
    const page = await open('widgets.html', client);

    const { report } = await runIn(page);

    assert.equal(await page.locator('#city').textContent(), '上海');
    assert.equal(statusOf(report, /工作城市/).status, 'filled');
    assert.equal(widgetCalls.length, 0);
    assert.equal(await page.locator('.popup').count(), 0, 'left a popup open');
    await page.close();
  });

  it('matches an answer shorter than the option text', async () => {
    const { client, widgetCalls } = oracle([[/最高学历/, ['硕士']]]);
    const page = await open('widgets.html', client);

    await runIn(page);

    assert.equal(await page.locator('#degree').textContent(), '硕士研究生');
    assert.equal(widgetCalls.length, 0);
    await page.close();
  });

  it('types into an async combobox and picks the committed option', async () => {
    const { client, widgetCalls } = oracle([[/Country/, ['China']]]);
    const page = await open('widgets.html', client);

    const { report } = await runIn(page);

    const country = page.locator('#country');
    assert.equal(await country.inputValue(), 'China');
    assert.equal(await country.getAttribute('data-committed'), 'China', 'typed but never chose an option');
    assert.equal(statusOf(report, /Country/).status, 'filled');
    assert.equal(widgetCalls.length, 0);
    await page.close();
  });

  it('walks a cascader level by level', async () => {
    const { client, widgetCalls } = oracle([[/所在地区/, ['广东省', '深圳市', '南山区']]]);
    const page = await open('widgets.html', client);

    const { report } = await runIn(page);

    assert.equal(await page.locator('#region').textContent(), '广东省 / 深圳市 / 南山区');
    assert.equal(statusOf(report, /所在地区/).status, 'filled');
    assert.equal(widgetCalls.length, 0);
    await page.close();
  });

  it('gives the model what it needs to work a calendar', async () => {
    const { client, widgetCalls } = oracle([[/入职日期/, ['2021-03-15']]]);
    const page = await open('widgets.html', client);

    const { report } = await runIn(page);

    assert.ok(widgetCalls.length > 0, 'a read-only calendar should need the model');
    const first = widgetCalls[0] as { view: { popupText: string; elements: Array<{ text: string }> } };
    assert.match(first.view.popupText, /2021年1月/, 'the calendar should already be open');
    const texts = first.view.elements.map((element) => element.text);
    assert.ok(texts.includes('下个月') && texts.includes('15'), texts.join('|'));
    assert.equal(statusOf(report, /入职日期/).status, 'failed', 'the scripted model gives up');
    await page.close();
  });

  it('shows a calendar and lets scripted steps complete it', async () => {
    const page = await open('widgets.html');
    const result = await page.evaluate(async () => {
      const driver = window.__aff.driver;
      const { fields } = await driver.snapshot();
      const field = fields.find((candidate) => candidate.label === '入职日期')!;

      const closed = await driver.widgetView(field.id);
      await driver.widgetClick(closed!.elements.find((e) => e.trigger)!.ref);
      await driver.settle();

      let view = await driver.widgetView(field.id);
      const popupText = view!.popupText;
      const next = view!.elements.find((e) => e.text === '下个月')!;
      await driver.widgetClick(next.ref);
      await driver.settle();

      view = await driver.widgetView(field.id);
      const day = view!.elements.find((e) => e.text === '15')!;
      await driver.widgetClick(day.ref);
      await driver.settle();

      return { field, open: closed!.open, popupText, reading: await driver.readField(field.id) };
    });

    assert.equal(result.field.kind, 'widget');
    assert.equal(result.field.widget, 'datepicker');
    assert.equal(result.open, false);
    assert.match(result.popupText, /2021年1月/);
    assert.equal(result.reading.value.trim(), '2021-02-15');
    await page.close();
  });

  it('reaches click handlers on inner wrappers, with no widget model calls', async () => {
    const { client, widgetCalls } = oracle([[/所属部门/, ['Engineering']]]);
    const page = await open('widgets.html', client);

    const { report } = await runIn(page);

    assert.equal((await page.locator('#dept .value').textContent())?.trim(), 'Engineering');
    assert.equal(statusOf(report, /所属部门/).status, 'filled');
    assert.equal(widgetCalls.length, 0);
    await page.close();
  });

  it('does not mistake a zero-width placeholder for an existing value', async () => {
    const page = await open('widgets.html');
    const fields = await snapshotOf(page);
    assert.equal(find(fields, /所属部门/).filled, false);
    await page.close();
  });

  it('types into the input inside a date picker and verifies it after commit', async () => {
    const { client, widgetCalls } = oracle([[/毕业日期/, ['2020-07-01']]]);
    const page = await open('widgets.html', client);

    const { report } = await runIn(page);

    const input = page.locator('#grad input');
    assert.equal(await input.inputValue(), '2020-07-01');
    assert.equal(await input.getAttribute('data-committed'), '2020-07-01');
    assert.equal(statusOf(report, /毕业日期/).status, 'filled');
    assert.equal(widgetCalls.length, 0);
    await page.close();
  });

  it('hides commit buttons and exit links from the widget view', async () => {
    const page = await open('widgets.html');
    const view = await page.evaluate(async () => {
      const driver = window.__aff.driver;
      const { fields } = await driver.snapshot();
      const field = fields.find((candidate) => candidate.label === '工作城市')!;
      const closed = await driver.widgetView(field.id);
      await driver.widgetClick(closed!.elements.find((e) => e.trigger)!.ref);
      await driver.settle();
      return driver.widgetView(field.id);
    });

    const texts = view!.elements.map((element) => element.text);
    assert.deepEqual(
      texts.filter((text) => ['北京', '上海', '深圳', '杭州'].includes(text)),
      ['北京', '上海', '深圳', '杭州']
    );
    assert.ok(!texts.includes('提交'), texts.join('|'));
    assert.ok(!texts.includes('See all cities'), texts.join('|'));
    await page.close();
  });

  it('refuses a forbidden click even with a valid ref', async () => {
    const page = await open('adversarial.html');
    const outcome = await page.evaluate(async () => {
      const button = document.querySelector('button[type="submit"]') as HTMLElement;
      const driver = window.__aff.driver as unknown as {
        elementRef(el: HTMLElement): string;
        widgetClick(ref: string): Promise<unknown>;
      };
      return driver.widgetClick(driver.elementRef(button));
    });
    assert.deepEqual(outcome, { ok: false, code: 'forbidden', detail: 'submit-button' });
    assert.equal(await page.evaluate(() => (window as any).__submitted), false);
    await page.close();
  });
});

describe('execution: pages that fight back', () => {
  const rules: Array<[RegExp, string[]]> = [
    [/currently employed/, ['Yes']],
    [/Current employer/, ['Example Technology']],
    [/^Country$/, ['China']],
    [/Province or state/, ['Guangdong']],
    [/^City$/, ['Shenzhen']],
    [/Mobile phone/, ['13800138000']],
    [/Team size/, ['11-50']],
    [/Department/, ['Engineering']],
  ];

  it('finds and fills fields revealed by earlier answers', async () => {
    const { client, planned } = oracle(rules);
    const page = await open('dynamic.html', client);

    const { report } = await runIn(page);

    assert.equal(await page.locator('[name="employer"]').inputValue(), 'Example Technology');
    assert.equal(await page.locator('[name="state"]').inputValue(), 'Guangdong');
    assert.equal(statusOf(report, /Current employer/).status, 'filled');
    assert.equal(statusOf(report, /Province or state/).status, 'filled');
    assert.ok(planned.length >= 2, 'revealed fields need a second planning pass');
    await page.close();
  });

  it('survives a controlled input that restores its state on blur', async () => {
    const { client } = oracle(rules);
    const page = await open('dynamic.html', client);

    const { report } = await runIn(page);

    assert.equal(await page.locator('#city').inputValue(), 'Shenzhen');
    assert.equal(statusOf(report, /^City$/).status, 'filled');
    await page.close();
  });

  it('sees through an input mask', async () => {
    const { client } = oracle(rules);
    const page = await open('dynamic.html', client);

    const { report } = await runIn(page);

    assert.equal(await page.locator('#mobile').inputValue(), '138-0013-8000');
    assert.equal(statusOf(report, /Mobile phone/).status, 'filled');
    await page.close();
  });

  it('recovers from a field replaced by a re-render', async () => {
    const { client } = oracle(rules);
    const page = await open('dynamic.html', client);

    const { report } = await runIn(page);

    assert.equal(await page.locator('[name="department"]').inputValue(), 'Engineering');
    const departments = report.outcomes.filter((outcome) => outcome.label === 'Department');
    assert.deepEqual(departments.map((outcome) => outcome.status), ['filled']);
    await page.close();
  });
});

describe('scan: shadow DOM and frames', () => {
  it('reads and fills inside an open shadow root', async () => {
    const { client } = oracle([[/Current employer/, ['Example Technology']]]);
    const page = await open('embedded.html', client);

    const fields = await snapshotOf(page);
    assert.equal(find(fields, /Current employer/).section, 'Inside a shadow root');

    await runIn(page);

    assert.equal(await page.locator('profile-card input').inputValue(), 'Example Technology');
    await page.close();
  });
});

describe('marks', () => {
  it('restores the page styling when cleared', async () => {
    const page = await open('contact.html');
    const outlines = await page.evaluate(async () => {
      const driver = window.__aff.driver;
      const { fields } = await driver.snapshot();
      const name = fields.find((field) => field.label === 'Full name')!;
      const el = document.getElementById('name')!;
      driver.mark(name.id, 'attention');
      const during = el.style.outline;
      driver.clearMarks();
      return { during, after: el.style.outline };
    });
    assert.match(outlines.during, /solid/);
    assert.equal(outlines.after, '');
    await page.close();
  });

  it('marks a choice group as a whole, not its first option', async () => {
    const page = await open('contact.html');
    const marked = await page.evaluate(async () => {
      const driver = window.__aff.driver;
      const { fields } = await driver.snapshot();
      driver.mark(fields.find((field) => field.label === 'Gender')!.id, 'filled');
      const outlined = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => el.style.outline);
      return outlined.map((el) => el.tagName);
    });
    assert.deepEqual(marked, ['FIELDSET']);
    await page.close();
  });
});
