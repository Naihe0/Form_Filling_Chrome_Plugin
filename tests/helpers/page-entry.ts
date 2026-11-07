/**
 * Injected into fixture pages by tests: the real driver and run loop, with
 * model calls bridged to Node through window.__llm, which Playwright exposes.
 */
import { DomPageDriver } from '../../src/dom/driver.ts';
import { runFill } from '../../src/harness/runner.ts';
import type {
  LlmClient,
  PlanRequest,
  RunEvent,
  RunOptions,
  TaskResponse,
  WidgetStepRequest,
} from '../../src/harness/types.ts';
import { LlmError, type LlmErrorCode } from '../../src/shared/errors.ts';
import type { RunReport } from '../../src/shared/types.ts';

type Bridged<T> = TaskResponse<T> | { error: { code: string; message: string } };

declare global {
  interface Window {
    __llm(kind: string, request: unknown): Promise<Bridged<unknown>>;
    __aff: {
      driver: DomPageDriver;
      run(options?: RunOptions): Promise<{ report: RunReport; events: RunEvent[] }>;
    };
  }
}

async function bridge<T>(kind: string, request: PlanRequest | WidgetStepRequest): Promise<TaskResponse<T>> {
  const reply = (await window.__llm(kind, request)) as Bridged<T>;
  if ('error' in reply) throw new LlmError(reply.error.code as LlmErrorCode, reply.error.message);
  return reply;
}

const llm: LlmClient = {
  plan: (request) => bridge('plan', request),
  widgetStep: (request) => bridge('widget', request),
};

const driver = new DomPageDriver();

window.__aff = {
  driver,
  async run(options = { overwrite: false }) {
    const events: RunEvent[] = [];
    const report = await runFill({
      page: driver,
      llm,
      options,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    return { report, events };
  },
};
