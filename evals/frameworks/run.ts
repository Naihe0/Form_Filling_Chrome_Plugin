/**
 * Live eval against real UI libraries, rather than the imitations in
 * tests/fixtures. Each form mirrors its framework's own state to window.__values,
 * so a pass means the framework's event handling really fired, not merely that
 * the right text appeared on screen.
 *
 *   GEMINI_API_KEY=... npm run eval:frameworks
 *   GEMINI_API_KEY=... npm run eval:frameworks -- --only antd --model gemini-3.8-flash
 *
 * Exits non-zero if any field is wrong or a form gets submitted.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createTaskClient } from '../../src/llm/tasks.ts';
import { PROVIDERS } from '../../src/shared/providers.ts';
import { exposeLlm, injectDriver, runIn } from '../../tests/helpers/browser.ts';
import { PROFILE } from '../cases.ts';

const { values: args } = parseArgs({
  options: { only: { type: 'string' }, model: { type: 'string', default: PROVIDERS.gemini.defaultModel } },
});

const apiKey = process.env.GEMINI_API_KEY ?? '';
if (!apiKey) {
  console.error('Set GEMINI_API_KEY to run the framework eval.');
  process.exit(2);
}

const NAME_ZH = /林薇|Wei Lin/;
const REGION = ['广东省', '深圳市', '南山区'];
const SKILLS = ['JavaScript', 'Python', 'Go'];
const EMAIL = 'wei.lin@example.com';

interface Framework {
  name: string;
  entry: string;
  css?: string;
  /** Expected framework state: an exact value, or a pattern for free or zoned values. */
  expected: Record<string, unknown>;
}

const FRAMEWORKS: Framework[] = [
  {
    name: 'antd',
    entry: 'antd.tsx',
    expected: {
      name: NAME_ZH,
      email: EMAIL,
      gender: '女',
      city: '深圳',
      degree: '硕士',
      region: REGION,
      // A dayjs value serialized as UTC, so the day shifts with the local zone.
      joined: /^2021-03-1[45]/,
      years: 6,
      skills: SKILLS,
      dept: 'Engineering',
      company: 'Example Technology',
    },
  },
  {
    name: 'mui',
    entry: 'mui.tsx',
    expected: {
      name: NAME_ZH,
      email: EMAIL,
      gender: 'female',
      degree: 'master',
      country: 'China',
      skills: SKILLS,
    },
  },
  {
    name: 'element',
    entry: 'element.ts',
    css: 'element-plus/dist/index.css',
    expected: {
      name: NAME_ZH,
      email: EMAIL,
      gender: '女',
      city: '深圳',
      degree: '硕士',
      region: REGION,
      joined: '2021-03-15',
      years: 6,
      skills: SKILLS,
    },
  },
];

const here = import.meta.dirname;
const buildDir = resolve(here, 'build');
mkdirSync(buildDir, { recursive: true });

const selected = FRAMEWORKS.filter((framework) => !args.only || framework.name === args.only);

for (const { name, entry, css } of selected) {
  await build({
    entryPoints: [join(here, 'src', entry)],
    outfile: join(buildDir, `${name}.js`),
    bundle: true,
    format: 'iife',
    target: 'chrome116',
    jsx: 'automatic',
    charset: 'utf8',
    logLevel: 'error',
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
  if (css) cpSync(join(here, 'node_modules', css), join(buildDir, `${name}.vendor.css`));
  const link = css ? `<link rel="stylesheet" href="${name}.vendor.css">` : '';
  writeFileSync(
    join(buildDir, `${name}.html`),
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title>${link}</head>` +
      `<body><div id="root"></div><script src="${name}.js"></script></body></html>`
  );
}

const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript; charset=utf-8' };
const server = createServer((request, response) => {
  const file = join(buildDir, new URL(request.url ?? '/', 'http://localhost').pathname);
  try {
    const body = readFileSync(file);
    response.writeHead(200, { 'content-type': TYPES[file.split('.').pop() ?? ''] ?? 'text/plain' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, done));
const { port } = server.address() as AddressInfo;

const client = createTaskClient({
  provider: PROVIDERS.gemini,
  model: args.model!,
  apiKey,
  profile: PROFILE,
  today: new Date().toLocaleDateString('sv'),
});

function fieldOk(expected: unknown, actual: unknown): boolean {
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
  return JSON.stringify(expected) === JSON.stringify(actual);
}

const browser = await chromium.launch();
let failures = 0;
console.log(`Model: gemini/${args.model}\n`);

for (const framework of selected) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  await exposeLlm(page, client);
  await page.goto(`http://localhost:${port}/${framework.name}.html`);
  await page.waitForLoadState('networkidle');
  await injectDriver(page);

  const { report } = await runIn(page);
  const state = await page.evaluate(() => (window as never as { __values: Record<string, unknown> }).__values);
  const submitted = await page.evaluate(() => (window as never as { __submitted: boolean }).__submitted);

  const wrong = Object.entries(framework.expected).filter(([key, want]) => !fieldOk(want, state[key]));
  const total = Object.keys(framework.expected).length;
  failures += wrong.length + (submitted ? 1 : 0);

  console.log(
    `${framework.name}: ${total - wrong.length}/${total} fields in framework state | ` +
      `${report.usage.calls} model calls, ${report.usage.totalTokens} tokens, ` +
      `${(report.durationMs / 1000).toFixed(1)}s | ${report.status}`
  );
  for (const [key, want] of wrong) {
    console.log(`    FAIL ${key}: expected ${String(want)}, got ${JSON.stringify(state[key])}`);
  }
  if (submitted) console.log('    FAIL the form was submitted');
  for (const outcome of report.outcomes.filter((candidate) => candidate.status !== 'filled')) {
    console.log(`    ${outcome.status} (${outcome.detail ?? '-'}): ${outcome.label}`);
  }
  await page.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll frameworks passed.' : `\n${failures} failures.`);
process.exit(failures === 0 ? 0 : 1);
