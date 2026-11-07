/**
 * Message contracts between the popup, the service worker and content scripts.
 *
 *   popup -> worker        run/start, run/stop, quick-query/sync
 *   worker -> frames       fill/start, fill/stop, quick-query/disable
 *   frames -> worker       run/update, quick-query/config
 *   frames <-> worker      the "llm" port, one per model call
 *
 * Run state lives in chrome.storage.session, one key per frame, so the service
 * worker can be restarted at any moment and the popup can open at any moment.
 */
import type { LlmTask } from '../llm/tasks.ts';
import type { Language } from './settings.ts';
import type { RunReport, Usage } from './types.ts';

export interface FrameRunState {
  runId: string;
  phase: 'running' | 'done';
  done: number;
  total: number;
  report?: RunReport;
}

export type StartFailure = 'no-profile' | 'no-key' | 'restricted-page';

export type StartResponse =
  | { ok: true; runId: string }
  | { ok: false; code: StartFailure; message?: string };

export type WorkerMessage =
  | { type: 'run/start'; tabId: number }
  | { type: 'run/stop'; tabId: number }
  | { type: 'run/update'; state: FrameRunState }
  | { type: 'quick-query/sync'; activeTabId?: number }
  | { type: 'quick-query/config' };

export type FrameMessage =
  | { type: 'fill/start'; runId: string; overwrite: boolean; language: Language }
  | { type: 'fill/stop' }
  | { type: 'quick-query/disable' };

export const LLM_PORT = 'llm';

export interface LlmPortRequest {
  task: LlmTask;
}

export type LlmPortResponse =
  | { ok: true; value: unknown; usage: Usage }
  | { ok: false; error: { code: string; message: string } };

const RUN_PREFIX = 'run:';

export const runKey = (tabId: number, frameId: number) => `${RUN_PREFIX}${tabId}:${frameId}`;

export const runKeyPrefix = (tabId: number) => `${RUN_PREFIX}${tabId}:`;
