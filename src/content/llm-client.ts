/**
 * The content-script side of the "llm" port. Holds no key and no profile; it
 * sends a task description and receives the result.
 *
 * Each call gets its own port. Disconnecting cancels the fetch in the worker,
 * and an unexpected disconnect means Chrome restarted the worker, which is
 * survivable: the call is simply sent again.
 */
import type { LlmClient, TaskResponse } from '../harness/types.ts';
import type { LlmTask } from '../llm/tasks.ts';
import { LlmError, RunStopped, type LlmErrorCode } from '../shared/errors.ts';
import { LLM_PORT, type LlmPortRequest, type LlmPortResponse } from '../shared/protocol.ts';

const MAX_REDELIVERIES = 2;

class WorkerRestarted extends Error {}

function sendOnce<T>(task: LlmTask, signal: AbortSignal): Promise<TaskResponse<T>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RunStopped());

    const port = chrome.runtime.connect({ name: LLM_PORT });
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      port.disconnect();
      action();
    };
    const onAbort = () => finish(() => reject(new RunStopped()));

    signal.addEventListener('abort', onAbort, { once: true });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new WorkerRestarted());
    });
    port.onMessage.addListener((response: LlmPortResponse) => {
      finish(() => {
        if (response.ok) resolve({ value: response.value as T, usage: response.usage });
        else if (response.error.code === 'internal') reject(new Error(response.error.message));
        else reject(new LlmError(response.error.code as LlmErrorCode, response.error.message));
      });
    });

    const request: LlmPortRequest = { task };
    port.postMessage(request);
  });
}

export async function callTask<T>(task: LlmTask, signal: AbortSignal): Promise<TaskResponse<T>> {
  for (let delivery = 0; ; delivery++) {
    try {
      return await sendOnce<T>(task, signal);
    } catch (error) {
      if (!(error instanceof WorkerRestarted)) throw error;
      if (delivery >= MAX_REDELIVERIES) {
        throw new LlmError('network', 'The extension background worker kept restarting.');
      }
    }
  }
}

export function createPortClient(): LlmClient {
  return {
    plan: (request, signal) => callTask({ kind: 'plan', request }, signal),
    widgetStep: (request, signal) => callTask({ kind: 'widget', request }, signal),
  };
}
