/**
 * Live evaluation: runs the harness against every fixture with a real model and
 * scores the resulting pages.
 *
 *   GEMINI_API_KEY=... npm run eval
 *   GEMINI_API_KEY=... npm run eval -- --extension --runs 3 --model gemini-3.8-flash
 *
 * Default mode injects the driver into each page and calls the provider from
 * Node, which is quick and isolates harness behaviour. --extension loads the
 * built extension and goes through its service worker, exactly as a user would.
 *
 * The key comes only from the environment and is never printed or reported.
 * Exits non-zero if a safety check fails or the score drops below --min-score.
 */
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { createTaskClient, type TaskConfig } from '../src/llm/tasks.ts';
import type { FrameRunState } from '../src/shared/protocol.ts';
import { isProviderId, PROVIDERS, type ProviderId } from '../src/shared/providers.ts';
import type { RunReport, Usage } from '../src/shared/types.ts';
import { DIST_DIR, exposeLlm, injectDriver, runIn, serveFixtures, type FixtureServer } from '../tests/helpers/browser.ts';
import { CASES, PROFILE, type Check, type EvalCase } from './cases.ts';

const { values: args } = parseArgs({
  options: {
    provider: { type: 'string', default: 'gemini' },
    model: { type: 'string' },
    runs: { type: 'string', default: '1' },
    only: { type: 'string' },
    extension: { type: 'boolean', default: false },
    'min-score': { type: 'string', default: '0.9' },
  },
});

const providerId = args.provider as ProviderId;
if (!isProviderId(providerId)) throw new Error(`Unknown provider: ${args.provider}`);
const provider = PROVIDERS[providerId];
const keyVar = `${providerId.toUpperCase()}_API_KEY`;
const apiKey = process.env[keyVar] ?? '';
if (!apiKey) {
  console.error(`Set ${keyVar} to run the live eval.`);
  process.exit(2);
}
const model = args.model ?? provider.defaultModel;

const config: TaskConfig = {
  provider,
  model,
  apiKey,
  profile: PROFILE,
  today: new Date().toLocaleDateString('sv'),
};

interface CheckResult {
  name: string;
  ok: boolean;
  safety: boolean;
  actual: unknown;
}

interface CaseResult {
  name: string;
  run: number;
  checks: CheckResult[];
  reports: RunReport[];
  usage: Usage;
  durationMs: number;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

function frameFor(page: Page, check: Check): Frame | Page {
  if (!check.frame) return page;
  const frame = page.frames().find((candidate) => candidate.url().includes(check.frame!));
  if (!frame) throw new Error(`No frame matching ${check.frame}`);
  return frame;
}

async function readActual(page: Page, check: Check): Promise<unknown> {
  const target = frameFor(page, check);
  const { read } = check;
  if ('flag' in read) {
    return target.evaluate((name) => (window as never as Record<string, unknown>)[name] ?? false, read.flag);
  }
  if ('value' in read) return target.locator(read.value).inputValue({ timeout: 2000 });
  if ('checked' in read) return target.locator(read.checked).isChecked({ timeout: 2000 });
  if ('text' in read) return (await target.locator(read.text).textContent({ timeout: 2000 }))?.trim();
  if ('allText' in read) return (await target.locator(read.allText).allTextContents()).join(',');
  if ('count' in read) return target.locator(read.count).count();
  return target.locator(read.of).getAttribute(read.attribute, { timeout: 2000 });
}

async function score(page: Page, evalCase: EvalCase): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of evalCase.checks) {
    let actual: unknown;
    let ok: boolean;
    try {
      actual = await readActual(page, check);
      const text = String(actual ?? '');
      ok = (check.equals === undefined || actual === check.equals)
        && (!check.matches || check.matches.test(text))
        && !(check.excludes ?? []).some((banned) => text.includes(banned));
    } catch (error) {
      ok = false;
      actual = `ERROR: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
    results.push({ name: check.name, ok, safety: !!check.safety, actual });
  }
  return results;
}

function totalUsage(reports: RunReport[]): Usage {
  return reports.reduce<Usage>(
    (sum, { usage }) => ({
      calls: sum.calls + usage.calls,
      promptTokens: sum.promptTokens + usage.promptTokens,
      completionTokens: sum.completionTokens + usage.completionTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  );
}

/* ------------------------------------------------------------------ */
/* Direct mode: driver in the page, model called from Node              */
/* ------------------------------------------------------------------ */

async function runDirect(browser: Browser, fixtures: FixtureServer, evalCase: EvalCase, run: number): Promise<CaseResult> {
  const page = await browser.newPage();
  await exposeLlm(page, createTaskClient(config));
  await page.goto(fixtures.url(evalCase.path));
  await page.waitForLoadState('networkidle');

  const started = Date.now();
  const frames = page.frames().filter((frame) => frame.url() !== 'about:blank' || frame === page.mainFrame());
  const reports = await Promise.all(
    frames.map(async (frame) => {
      await injectDriver(frame);
      return (await runIn(frame)).report;
    })
  );

  const result: CaseResult = {
    name: evalCase.name,
    run,
    checks: await score(page, evalCase),
    reports,
    usage: totalUsage(reports),
    durationMs: Date.now() - started,
  };
  await page.close();
  return result;
}

/* ------------------------------------------------------------------ */
/* Extension mode: the real thing                                       */
/* ------------------------------------------------------------------ */

async function launchExtension(): Promise<{ context: BrowserContext; admin: Page; extensionId: string; cleanup: () => Promise<void> }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'aff-eval-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(process.env.AFF_CHROMIUM_PATH ? { executablePath: process.env.AFF_CHROMIUM_PATH } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${DIST_DIR}`, `--load-extension=${DIST_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  // An extension page; unlike a worker handle, it stays valid when Chrome restarts the worker.
  const admin = await context.newPage();
  await admin.goto(`chrome-extension://${extensionId}/popup.html`);
  await admin.evaluate(
    ([settings]) => chrome.storage.local.set({ settings }),
    [
      {
        schemaVersion: 3,
        language: 'en',
        provider: providerId,
        providers: { [providerId]: { apiKey, model } },
        profile: PROFILE,
        profileUpdatedAt: Date.now(),
        quickQuery: false,
        overwrite: false,
      },
    ]
  );
  return {
    context,
    admin,
    extensionId,
    cleanup: async () => {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function runThroughExtension(
  env: Awaited<ReturnType<typeof launchExtension>>,
  fixtures: FixtureServer,
  evalCase: EvalCase,
  run: number
): Promise<CaseResult> {
  const { context, admin, extensionId } = env;
  const page = await context.newPage();
  await page.goto(fixtures.url(evalCase.path));
  await page.waitForLoadState('networkidle');

  const tabId: number = await admin.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)!.id!;
  }, page.url());

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);

  const started = Date.now();
  await popup.locator('#start').click();

  let states: FrameRunState[] = [];
  const deadline = Date.now() + 240_000;
  for (;;) {
    states = await admin.evaluate(async (id) => {
      const all = await chrome.storage.session.get(null);
      return Object.entries(all)
        .filter(([key]) => key.startsWith(`run:${id}:`))
        .map(([, state]) => state) as never;
    }, tabId);
    if (states.length > 0 && states.every((state) => state.phase === 'done')) break;
    if (Date.now() > deadline) throw new Error(`${evalCase.name}: run did not finish`);
    await new Promise((done) => setTimeout(done, 250));
  }

  const reports = states.flatMap((state) => (state.report ? [state.report] : []));
  const result: CaseResult = {
    name: evalCase.name,
    run,
    checks: await score(page, evalCase),
    reports,
    usage: totalUsage(reports),
    durationMs: Date.now() - started,
  };
  await popup.close();
  await page.close();
  return result;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const cases = args.only ? CASES.filter((candidate) => candidate.name.includes(args.only!)) : CASES;
const runs = Number(args.runs);
const results: CaseResult[] = [];
const fixtures = await serveFixtures();

console.log(`Model: ${providerId}/${model}   Mode: ${args.extension ? 'extension' : 'direct'}   Runs: ${runs}\n`);

let cleanup: () => Promise<void>;
let runCase: (evalCase: EvalCase, run: number) => Promise<CaseResult>;

if (args.extension) {
  const env = await launchExtension();
  cleanup = env.cleanup;
  runCase = (evalCase, run) => runThroughExtension(env, fixtures, evalCase, run);
} else {
  const browser = await chromium.launch();
  cleanup = () => browser.close();
  runCase = (evalCase, run) => runDirect(browser, fixtures, evalCase, run);
}

for (let run = 1; run <= runs; run++) {
  for (const evalCase of cases) {
    const result = await runCase(evalCase, run);
    results.push(result);

    const passed = result.checks.filter((check) => check.ok).length;
    const statuses = result.reports.map((report) => report.status).join(',');
    console.log(
      `[run ${run}] ${result.name}: ${passed}/${result.checks.length} checks | ` +
        `${result.usage.calls} calls, ${result.usage.totalTokens} tokens, ` +
        `${(result.durationMs / 1000).toFixed(1)}s | ${statuses}`
    );
    for (const check of result.checks.filter((candidate) => !candidate.ok)) {
      console.log(`    ${check.safety ? 'SAFETY ' : ''}FAIL ${check.name}: got ${JSON.stringify(check.actual)}`);
    }
    for (const report of result.reports.filter((candidate) => candidate.error)) {
      console.log(`    run error: ${report.error!.code}`);
    }
  }
}

await cleanup();
await fixtures.close();

const allChecks = results.flatMap((result) => result.checks);
const passedChecks = allChecks.filter((check) => check.ok).length;
const scoreValue = allChecks.length ? passedChecks / allChecks.length : 0;
const safetyFailures = allChecks.filter((check) => check.safety && !check.ok);
const usage = totalUsage(results.flatMap((result) => result.reports));
const seconds = results.reduce((sum, result) => sum + result.durationMs, 0) / 1000;

console.log(`\nScore: ${passedChecks}/${allChecks.length} (${(scoreValue * 100).toFixed(1)}%)`);
console.log(`Safety failures: ${safetyFailures.length}`);
console.log(`Model calls: ${usage.calls}, tokens: ${usage.totalTokens}, time: ${seconds.toFixed(1)}s`);

const reportsDir = resolve(import.meta.dirname, '../reports');
await mkdir(reportsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(reportsDir, `eval-${stamp}.json`);
await writeFile(
  reportPath,
  JSON.stringify(
    {
      model: `${providerId}/${model}`,
      mode: args.extension ? 'extension' : 'direct',
      runs,
      score: scoreValue,
      safetyFailures: safetyFailures.length,
      usage,
      seconds,
      results,
    },
    null,
    2
  )
);
console.log(`Report: ${reportPath}`);

process.exit(safetyFailures.length > 0 || scoreValue < Number(args['min-score']) ? 1 : 0);
