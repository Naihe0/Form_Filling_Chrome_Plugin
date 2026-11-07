/** Shared plumbing for tests and evals that drive a real browser. */
import { build } from 'esbuild';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from 'playwright';
import type { LlmClient, PlanRequest, RunEvent, RunOptions, WidgetStepRequest } from '../../src/harness/types.ts';
import { LlmError } from '../../src/shared/errors.ts';
import type { FieldView, RunReport } from '../../src/shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(here, '../fixtures');
export const DIST_DIR = resolve(here, '../../dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export interface FixtureServer {
  server: Server;
  port: number;
  url(path: string): string;
  close(): Promise<void>;
}

/** Serves the fixtures on every local address, so localhost and 127.0.0.1 are two origins. */
export async function serveFixtures(): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = join(FIXTURES_DIR, path);
    if (!file.startsWith(FIXTURES_DIR) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, done));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    url: (path) => `http://localhost:${port}/${path}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

let pageBundle: string | undefined;

/** The driver and run loop as a script to inject into a page. */
export async function pageScript(): Promise<string> {
  if (!pageBundle) {
    const result = await build({
      entryPoints: [resolve(here, 'page-entry.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'chrome116',
      charset: 'utf8',
    });
    pageBundle = result.outputFiles[0].text;
  }
  return pageBundle;
}

/** Routes the page's window.__llm calls to a client running in Node. */
export async function exposeLlm(page: Page, client: LlmClient): Promise<void> {
  const signal = new AbortController().signal;
  await page.exposeFunction('__llm', async (kind: string, request: unknown) => {
    try {
      return kind === 'plan'
        ? await client.plan(request as PlanRequest, signal)
        : await client.widgetStep(request as WidgetStepRequest, signal);
    } catch (error) {
      if (error instanceof LlmError) return { error: { code: error.code, message: error.message } };
      throw error;
    }
  });
}

export async function injectDriver(frame: Frame | Page): Promise<void> {
  await frame.addScriptTag({ content: await pageScript() });
}

export async function snapshotOf(frame: Frame | Page): Promise<FieldView[]> {
  return frame.evaluate(async () => (await window.__aff.driver.snapshot()).fields);
}

export async function runIn(
  frame: Frame | Page,
  options?: RunOptions
): Promise<{ report: RunReport; events: RunEvent[] }> {
  return frame.evaluate((runOptions) => window.__aff.run(runOptions), options);
}
