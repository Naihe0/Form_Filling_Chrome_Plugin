/**
 * The whole extension, loaded into Chromium: service worker, on-demand content
 * scripts in every frame, the popup UI, and the port between them. The provider
 * is stubbed at the network layer, so what is asserted about requests is what
 * would really leave the browser.
 */
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { chromium, type BrowserContext, type Page, type Route } from 'playwright';
import type { FrameRunState } from '../../src/shared/protocol.ts';
import type { FieldOutcome } from '../../src/shared/types.ts';
import { DIST_DIR, serveFixtures, type FixtureServer } from '../helpers/browser.ts';

const API_KEY = 'stub-key-not-real';
const PROFILE = 'PROFILE-MARKER. Name: Wei Lin. Email: wei@example.com.';
const GEMINI = 'https://generativelanguage.googleapis.com/**';

let context: BrowserContext;
/** An extension page; unlike a worker handle, it stays valid when Chrome restarts the worker. */
let admin: Page;
let extensionId: string;
let fixtures: FixtureServer;
let userDataDir: string;

interface CapturedRequest {
  body: any;
  headers: Record<string, string>;
}

/** Answers planning calls as an SSE stream by matching labels in the prompt. */
function stubProvider(answerFor: (fieldLine: any) => string[], captured: CapturedRequest[] = []) {
  return async (route: Route) => {
    const request = route.request();
    const body = request.postDataJSON();
    captured.push({ body, headers: request.headers() });

    const prompt: string = body.messages.at(-1).content;
    const section = prompt.match(/<page_fields>\n([\s\S]*?)\n<\/page_fields>/)?.[1] ?? '';
    const fields = section.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const answers = fields.map((field) => ({ field: field.id, answer: answerFor(field) }));

    const chunk = {
      choices: [{ delta: { content: JSON.stringify({ answers }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 150 },
    };
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    });
  };
}

async function seedSettings(patch: Record<string, unknown> = {}): Promise<void> {
  const settings = {
    schemaVersion: 3,
    language: 'en',
    provider: 'gemini',
    providers: { gemini: { apiKey: API_KEY, model: '' } },
    profile: PROFILE,
    profileUpdatedAt: 1,
    quickQuery: false,
    overwrite: false,
    ...patch,
  };
  await admin.evaluate(async (value) => {
    // A profile synced by an earlier test would rightly win over this older seed.
    await chrome.storage.sync.clear();
    await chrome.storage.local.set({ settings: value });
  }, settings);
}

async function tabIdOf(url: string): Promise<number> {
  return admin.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)!.id!;
  }, url);
}

async function openPopup(tabId: number): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('body[data-ready]', { state: 'attached' });
  return popup;
}

async function frameStates(tabId: number): Promise<FrameRunState[]> {
  return admin.evaluate(async (id) => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(`run:${id}:`))
      .map(([, value]) => value) as never;
  }, tabId);
}

async function untilDone(tabId: number, timeoutMs = 20_000): Promise<FrameRunState[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await frameStates(tabId);
    if (states.length > 0 && states.every((state) => state.phase === 'done')) return states;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run did not finish: ${JSON.stringify(await frameStates(tabId))}`);
}

const outcomes = (states: FrameRunState[]): FieldOutcome[] =>
  states.flatMap((state) => state.report?.outcomes ?? []);

before(async () => {
  fixtures = await serveFixtures();
  userDataDir = await mkdtemp(join(tmpdir(), 'aff-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // Full Chromium, not the headless shell, which cannot load extensions.
    ...(process.env.AFF_CHROMIUM_PATH
      ? { executablePath: process.env.AFF_CHROMIUM_PATH }
      : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${DIST_DIR}`, `--load-extension=${DIST_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  admin = await context.newPage();
  await admin.goto(`chrome-extension://${extensionId}/popup.html`);
});

after(async () => {
  await context.close();
  await fixtures.close();
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 });
});

afterEach(async () => {
  await context.unroute(GEMINI);
  for (const page of context.pages()) {
    if (page !== admin) await page.close();
  }
});

describe('extension: loading', () => {
  it('injects nothing into pages until asked', async () => {
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const installed = await admin.evaluate(async (id) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => (window as any).__affFillInstalled ?? false,
      });
      return result;
    }, tabId);
    assert.equal(installed, false);
  });
});

describe('extension: a full run through the popup', () => {
  it('fills the page, stays inside policy, and reports back', async () => {
    const captured: CapturedRequest[] = [];
    await context.route(
      GEMINI,
      stubProvider((field) => {
        if (/Full name/.test(field.label)) return ['Wei Lin'];
        if (/^Email/.test(field.label)) return ['wei@example.com'];
        if (/Gender/.test(field.label)) return [field.options[1].id];
        return [];
      }, captured)
    );
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    const states = await untilDone(tabId);

    assert.equal(await page.locator('[name="fullName"]').inputValue(), 'Wei Lin');
    assert.equal(await page.locator('[name="email"]').inputValue(), 'wei@example.com');
    assert.equal(await page.locator('input[name="gender"][value="f"]').isChecked(), true);
    assert.equal(await page.locator('[name="password"]').inputValue(), '');
    assert.equal(await page.evaluate(() => (window as any).__submitted), undefined);

    const results = outcomes(states);
    assert.equal(results.find((o) => o.label === 'Full name')?.status, 'filled');
    assert.equal(results.find((o) => /password/i.test(o.label))?.status, 'blocked');

    // The popup shows the report, including what the user must do themselves.
    await popup.locator('#viewReport').waitFor({ state: 'visible' });
    assert.match(await popup.locator('#reportTitle').textContent() ?? '', /Review before submitting/);
    assert.match(await popup.locator('#reportSummary').textContent() ?? '', /3 filled/);
    assert.match(await popup.locator('#reportList').textContent() ?? '', /Create a password/);
    assert.match(await popup.locator('#reportUsage').textContent() ?? '', /Model calls: 1/);

    // What actually left the browser.
    const [request] = captured;
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    const sent = JSON.stringify(request.body.messages);
    assert.ok(sent.includes('PROFILE-MARKER'));
    assert.ok(!sent.includes('CSRF-SECRET-VALUE'), 'a hidden token left the browser');
    assert.ok(!sent.includes('<form'), 'raw HTML left the browser');
    assert.ok(!/Create a password|Card number/.test(sent), 'a blocked field was shown to the model');
    assert.equal(request.body.reasoning_effort, 'low');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.response_format.type, 'json_schema');
  });

  it('can run twice on the same page, which v2 could not', async () => {
    await context.route(GEMINI, stubProvider((f) => (/Full name/.test(f.label) ? ['Wei Lin'] : [])));
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await untilDone(tabId);
    await popup.locator('#back').click();

    await page.locator('[name="fullName"]').fill('');
    await popup.locator('#start').click();
    await page.waitForFunction(() => (document.querySelector('[name="fullName"]') as HTMLInputElement).value === 'Wei Lin');
    await untilDone(tabId);
  });

  it('fills same-origin and cross-origin frames and shadow DOM, at no cost for empty frames', async () => {
    const captured: CapturedRequest[] = [];
    await context.route(
      GEMINI,
      stubProvider((field) => {
        if (/Full name/.test(field.label)) return ['Wei Lin'];
        if (/Email/.test(field.label)) return ['wei@example.com'];
        if (/Phone/.test(field.label)) return ['13800138000'];
        if (/employer/.test(field.label)) return ['Example Technology'];
        return [];
      }, captured)
    );
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('embedded.html'));
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 3);
    await page.waitForLoadState('networkidle');
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await untilDone(tabId);

    assert.equal(await page.locator('[name="top_name"]').inputValue(), 'Wei Lin');
    assert.equal(await page.locator('profile-card input').inputValue(), 'Example Technology');
    assert.equal(await page.frameLocator('#same').locator('[name="frame_email"]').inputValue(), 'wei@example.com');
    assert.equal(await page.frameLocator('#cross').locator('[name="frame_phone"]').inputValue(), '13800138000');
    // Top document, same-origin frame, cross-origin frame. Not the ad frame.
    assert.equal(captured.length, 3);
  });
});

describe('extension: stopping', () => {
  it('Stop cancels the call in flight and leaves the page alone', async () => {
    let requestSeen!: () => void;
    const seen = new Promise<void>((resolve) => (requestSeen = resolve));
    await context.route(GEMINI, async (route) => {
      requestSeen();
      // Never answers; only Stop can end this.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      await route.abort().catch(() => {});
    });
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await seen;
    await popup.locator('#stop').click();

    const states = await untilDone(tabId, 5000);
    assert.ok(states.some((state) => state.report?.status === 'stopped'));
    assert.equal(await page.locator('[name="fullName"]').inputValue(), '');
    await popup.locator('#viewReport').waitFor({ state: 'visible' });
    assert.match(await popup.locator('#reportTitle').textContent() ?? '', /Stopped/);
  });
});

describe('extension: staying robust', () => {
  it('does not call the model on a page with no fields', async () => {
    const captured: CapturedRequest[] = [];
    await context.route(GEMINI, stubProvider(() => [], captured));
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('empty.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await untilDone(tabId);

    await popup.locator('#viewReport').waitFor({ state: 'visible' });
    assert.match(await popup.locator('#reportTitle').textContent() ?? '', /No fillable fields/);
    assert.equal(captured.length, 0);
  });

  it('forgets a dismissed report for good', async () => {
    await context.route(GEMINI, stubProvider(() => []));
    await seedSettings();
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await untilDone(tabId);
    await popup.locator('#back').click();
    await popup.locator('#viewFill').waitFor({ state: 'visible' });

    await popup.reload();
    await popup.waitForSelector('body[data-ready]', { state: 'attached' });
    assert.equal(await popup.locator('#viewFill').isVisible(), true);
    assert.equal(await popup.locator('#viewReport').isVisible(), false);
  });

  it('does not leave the popup spinning when the user navigates away mid-run', async () => {
    let requestSeen!: () => void;
    const seen = new Promise<void>((resolve) => (requestSeen = resolve));
    await context.route(GEMINI, async (route) => {
      requestSeen();
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await route.abort().catch(() => {});
    });
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await seen;
    await page.goto(fixtures.url('empty.html'));

    const deadline = Date.now() + 4000;
    let states = await frameStates(tabId);
    while (states.some((state) => state.phase === 'running') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      states = await frameStates(tabId);
    }
    assert.ok(!states.some((state) => state.phase === 'running'), JSON.stringify(states));
    await popup.locator('#viewRunning').waitFor({ state: 'hidden' });
  });
});

describe('extension: failures users can act on', () => {
  it('reports a rejected key in plain language', async () => {
    await context.route(GEMINI, (route) =>
      route.fulfill({ status: 401, body: JSON.stringify({ error: { message: 'API key not valid' } }) })
    );
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await untilDone(tabId);

    await popup.locator('#viewReport').waitFor({ state: 'visible' });
    assert.match(await popup.locator('#reportTitle').textContent() ?? '', /rejected the API key/);
  });

  it('asks for a profile first', async () => {
    await seedSettings({ profile: '' });
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const popup = await openPopup(await tabIdOf(page.url()));

    await popup.locator('#start').click();

    await popup.locator('#status', { hasText: 'profile' }).waitFor();
    assert.equal(await popup.locator('#viewProfile').isVisible(), true);
  });

  it('asks for a key first', async () => {
    await seedSettings({ providers: {} });
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const popup = await openPopup(await tabIdOf(page.url()));

    await popup.locator('#start').click();

    await popup.locator('#status', { hasText: 'API key' }).waitFor();
  });

  it('explains pages Chrome keeps extensions out of', async () => {
    await seedSettings();
    const page = await context.newPage();
    await page.goto('chrome://version');
    // Without the tabs permission, a chrome:// tab exposes no URL to search by.
    const tabId = await admin.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab.id!;
    });
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();

    await popup.locator('#status', { hasText: 'does not allow' }).waitFor();
  });
});

describe('extension: the trust boundary', () => {
  it('keeps the key and profile out of reach of content scripts', async () => {
    await seedSettings();
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());

    const result = await admin.evaluate(async (id) => {
      const [{ result: fromContent }] = await chrome.scripting.executeScript({
        target: { tabId: id },
        world: 'ISOLATED',
        func: async () => {
          try {
            return JSON.stringify(await chrome.storage.local.get(null));
          } catch (error) {
            return `denied: ${String(error)}`;
          }
        },
      });
      return fromContent;
    }, tabId);

    assert.match(String(result), /denied/);
    assert.ok(!String(result).includes(API_KEY));
  });

  it('refuses run commands from a content script', async () => {
    await seedSettings();
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());

    await admin.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: (target: number) => {
          chrome.runtime.sendMessage({ type: 'run/start', tabId: target }).catch(() => {});
        },
        args: [id],
      });
    }, tabId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(await frameStates(tabId), []);
  });

  it('never writes the key to synced storage', async () => {
    await seedSettings();
    const popupPage = await context.newPage();
    await popupPage.goto(fixtures.url('contact.html'));
    const popup = await openPopup(await tabIdOf(popupPage.url()));

    await popup.locator('#tabProfile').click();
    await popup.locator('#profile').fill('Synced profile text');
    await popup.locator('#saveProfile').click();
    await popup.locator('#status', { hasText: 'saved' }).waitFor();

    const synced = await admin.evaluate(() => chrome.storage.sync.get(null));
    assert.equal(synced.profile, 'Synced profile text');
    assert.ok(!JSON.stringify(synced).includes(API_KEY));
  });
});

describe('extension: settings UI', () => {
  it('switches language at runtime', async () => {
    await seedSettings();
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const popup = await openPopup(await tabIdOf(page.url()));

    assert.equal(await popup.locator('#start').textContent(), 'Start Filling');
    await popup.locator('#langZh').click();
    assert.equal(await popup.locator('#start').textContent(), '开始填充');
  });

  it('keeps a separate key per provider', async () => {
    await seedSettings();
    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const popup = await openPopup(await tabIdOf(page.url()));

    assert.equal(await popup.locator('#apiKey').inputValue(), API_KEY);
    await popup.locator('#provider').selectOption('openai');
    assert.equal(await popup.locator('#apiKey').inputValue(), '');
    assert.equal(await popup.locator('#model').getAttribute('placeholder'), 'Default: gpt-5.2');
    await popup.locator('#apiKey').fill('other-key');
    await popup.locator('#apiKey').blur();

    await popup.locator('#provider').selectOption('gemini');
    assert.equal(await popup.locator('#apiKey').inputValue(), API_KEY);
    await popup.locator('#provider').selectOption('openai');
    await popup.waitForFunction(() => (document.getElementById('apiKey') as HTMLInputElement).value === 'other-key');

    // Both survive reopening the popup.
    await popup.reload();
    await popup.waitForSelector('body[data-ready]', { state: 'attached' });
    assert.equal(await popup.locator('#apiKey').inputValue(), 'other-key');
    await popup.locator('#provider').selectOption('gemini');
    assert.equal(await popup.locator('#apiKey').inputValue(), API_KEY);
  });

  it('migrates v2 settings, and clears keys out of sync', async () => {
    await admin.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.sync.clear();
      const legacy = {
        userProfile: JSON.stringify(['Old profile']),
        userProfile_ts: 5,
        selectedProvider: 'gemini',
        providerConfigs: { gemini: { apiKey: 'v2-key', modelId: 'gemini-x' } },
        quick_query_enabled: false,
      };
      await chrome.storage.local.set(legacy);
      await chrome.storage.sync.set(legacy);
    });

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const popup = await openPopup(await tabIdOf(page.url()));

    assert.equal(await popup.locator('#apiKey').inputValue(), 'v2-key');
    assert.equal(await popup.locator('#model').inputValue(), 'gemini-x');
    const synced = await admin.evaluate(() => chrome.storage.sync.get(null));
    assert.ok(!JSON.stringify(synced).includes('v2-key'));
    assert.equal(synced.profile, 'Old profile');
  });
});

describe('extension: Quick Query', () => {
  it('completes text on the trigger, only while enabled', async () => {
    const captured: CapturedRequest[] = [];
    await context.route(GEMINI, async (route) => {
      captured.push({ body: route.request().postDataJSON(), headers: route.request().headers() });
      const chunk = { choices: [{ delta: { content: 'Shenzhen' }, finish_reason: 'stop' }] };
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
      });
    });
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('survey-cn.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    // Off by default: nothing is listening.
    const box = page.locator('textarea[name="intro"]');
    await box.fill('I live in ```');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(captured.length, 0);

    await popup.locator('.toggle-row', { hasText: 'Quick Query' }).click();
    await page.waitForFunction(() => true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await box.fill('');
    await box.pressSequentially('I live in ```');
    await page.waitForFunction(
      () => (document.querySelector('textarea[name="intro"]') as HTMLTextAreaElement).value === 'I live in Shenzhen'
    );
    assert.equal(captured.length, 1);
    assert.ok(JSON.stringify(captured[0].body.messages).includes('PROFILE-MARKER'));

    // And off again.
    await popup.locator('.toggle-row', { hasText: 'Quick Query' }).click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await box.fill('');
    await box.pressSequentially('More text ```');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(captured.length, 1);
  });

  it('does not overwrite text typed while the model was thinking', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await context.route(GEMINI, async (route) => {
      await held;
      const chunk = { choices: [{ delta: { content: 'Shenzhen' }, finish_reason: 'stop' }] };
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
      });
    });
    await seedSettings({ quickQuery: true });
    await admin.evaluate(() =>
      chrome.scripting.registerContentScripts([
        { id: 'quick-query', js: ['quick-query.js'], matches: ['<all_urls>'], allFrames: true, runAt: 'document_idle' },
      ])
    );

    const page = await context.newPage();
    await page.goto(fixtures.url('survey-cn.html'));
    const box = page.locator('textarea[name="intro"]');
    await box.pressSequentially('I live in ```');
    await box.pressSequentially(' never mind');
    release();
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(await box.inputValue(), 'I live in ``` never mind');
    await admin.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ['quick-query'] }));
  });

  it('never sends a password box to the model', async () => {
    const captured: unknown[] = [];
    await context.route(GEMINI, (route) => {
      captured.push(route.request());
      return route.abort();
    });
    await seedSettings({ quickQuery: true });
    await admin.evaluate(() =>
      chrome.scripting.getRegisteredContentScripts({ ids: ['quick-query'] }).then((found) =>
        found.length
          ? undefined
          : chrome.scripting.registerContentScripts([
              { id: 'quick-query', js: ['quick-query.js'], matches: ['<all_urls>'], allFrames: true, runAt: 'document_idle' },
            ])
      )
    );

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    await page.locator('[name="password"]').pressSequentially('secret```');
    await page.locator('[name="cardnum"]').pressSequentially('4111```');
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(captured.length, 0);
    await admin.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ['quick-query'] }));
  });
});

describe('extension: worker lifecycle', () => {
  // Keep this test last in the file: it restarts the worker the others rely on.
  it('survives Chrome stopping the service worker during a model call', async () => {
    let requests = 0;
    let firstSeen!: () => void;
    const seen = new Promise<void>((resolve) => (firstSeen = resolve));
    const answer = stubProvider((field) => (/Full name/.test(field.label) ? ['Wei Lin'] : []));
    await context.route(GEMINI, async (route) => {
      requests++;
      if (requests === 1) {
        firstSeen();
        // Hangs until the worker dies; the retry is the one that gets answered.
        await new Promise((resolve) => setTimeout(resolve, 6000));
        await route.abort().catch(() => {});
        return;
      }
      await answer(route);
    });
    await seedSettings();

    const page = await context.newPage();
    await page.goto(fixtures.url('contact.html'));
    const tabId = await tabIdOf(page.url());
    const popup = await openPopup(tabId);

    await popup.locator('#start').click();
    await seen;

    const cdp = await context.newCDPSession(popup);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');

    await page.waitForFunction(
      () => (document.querySelector('[name="fullName"]') as HTMLInputElement).value === 'Wei Lin',
      undefined,
      { timeout: 15_000 }
    );
    assert.ok(requests >= 2, `expected a retried call, saw ${requests}`);

    // Run state outlived the worker too, so the popup still finishes.
    await popup.locator('#viewReport').waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(await popup.locator('#reportTitle').textContent() ?? '', /Review before submitting/);
  });
});
