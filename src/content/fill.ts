/**
 * Content script for one frame's fill run. Injected on demand, into every frame
 * of the tab, only when the user presses Start.
 *
 * The run lives here rather than in the service worker because Chrome can stop
 * a worker at any time, while this context lasts exactly as long as the page
 * being filled. Each frame runs independently; one with no fields ends at once,
 * having cost no model call.
 */
import { DomPageDriver } from '../dom/driver.ts';
import { runFill } from '../harness/runner.ts';
import type { RunEvent } from '../harness/types.ts';
import { detailMessage, errorMessage, setLanguage, t } from '../shared/i18n.ts';
import type { FrameMessage, FrameRunState, WorkerMessage } from '../shared/protocol.ts';
import { emptyUsage, type RunReport } from '../shared/types.ts';
import { createPortClient } from './llm-client.ts';
import { StatusPanel } from './panel.ts';

declare global {
  interface Window {
    __affFillInstalled?: boolean;
  }
}

/** How long a clean result stays on screen. */
const PANEL_LINGER_MS = 4000;

function post(state: FrameRunState): void {
  const message: WorkerMessage = { type: 'run/update', state };
  chrome.runtime.sendMessage(message).catch(() => {});
}

function install(): void {
  const driver = new DomPageDriver();
  let controller: AbortController | null = null;
  let panel: StatusPanel | null = null;
  let currentRun = '';
  let progress = { done: 0, total: 0 };

  const onEvent = (event: RunEvent) => {
    switch (event.type) {
      case 'snapshot':
        // The panel only appears in frames that actually have a form.
        if (event.total > 0 && !panel) panel = new StatusPanel();
        break;
      case 'plan-start':
        panel?.setStatus(t('panelPlanning', { count: event.fields }), true);
        break;
      case 'field-start':
        panel?.setStatus(t('panelFilling', { done: event.done + 1, total: event.total, label: event.label }));
        progress = { done: event.done, total: event.total };
        post({ runId: currentRun, phase: 'running', ...progress });
        break;
      case 'field-done':
        progress = { done: event.done, total: event.total };
        post({ runId: currentRun, phase: 'running', ...progress });
        break;
      default:
        break;
    }
  };

  const showReport = (report: RunReport) => {
    if (!panel) return;
    const attention = report.outcomes.filter((outcome) =>
      outcome.status === 'failed' || outcome.status === 'blocked' || outcome.status === 'unconfirmed'
        || (outcome.status === 'skipped' && outcome.required)
    );
    const filled = report.outcomes.filter((outcome) => outcome.status === 'filled').length;

    if (report.status === 'stopped') {
      panel.setStatus(t('panelStopped'));
    } else if (report.status === 'failed' && report.error) {
      panel.setStatus(t('panelFailed', { message: errorMessage(report.error) }));
    } else if (attention.length > 0) {
      panel.setStatus(t('panelDone', { filled, attention: attention.length }));
    } else if (filled > 0) {
      panel.setStatus(t('panelAllGood', { filled }));
    } else {
      panel.setStatus(t('panelNothing'));
    }

    panel.setItems(
      attention.map((outcome) => ({
        label: outcome.label,
        detail: detailMessage(outcome.detail),
        onClick: () => driver.scrollToField(outcome.fieldId),
      }))
    );
    // Anything that needs the user stays up until they close it.
    if (attention.length === 0 && report.status === 'completed') panel.removeAfter(PANEL_LINGER_MS);
  };

  const start = async (runId: string, overwrite: boolean) => {
    if (controller) return;
    controller = new AbortController();
    currentRun = runId;
    progress = { done: 0, total: 0 };
    driver.clearMarks();
    panel?.remove();
    panel = null;

    try {
      const report = await runFill({
        page: driver,
        llm: createPortClient(),
        signal: controller.signal,
        options: { overwrite },
        emit: onEvent,
      });
      showReport(report);
      post({ runId, phase: 'done', ...progress, report });
    } finally {
      controller = null;
    }
  };

  chrome.runtime.onMessage.addListener((message: FrameMessage) => {
    if (message.type === 'fill/start') {
      setLanguage(message.language);
      void start(message.runId, message.overwrite);
    } else if (message.type === 'fill/stop') {
      controller?.abort();
    }
  });

  // Leaving the page ends the run, and code after this event may never execute,
  // so say so now rather than leave the popup waiting on a report.
  window.addEventListener('pagehide', () => {
    if (!controller) return;
    controller.abort();
    post({
      runId: currentRun,
      phase: 'done',
      ...progress,
      report: {
        status: 'stopped',
        outcomes: [],
        usage: emptyUsage(),
        passes: 0,
        durationMs: 0,
      },
    });
  });
}

if (!window.__affFillInstalled) {
  window.__affFillInstalled = true;
  install();
}
