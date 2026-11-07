/**
 * Service worker: the trusted side of the extension.
 *
 * It alone reads the API key and the profile, and it alone talks to providers.
 * Content scripts run in the same process as untrusted pages, so they send
 * tasks here and get back only the answers a page is going to receive anyway.
 *
 * It keeps no state in memory. Chrome may stop it at any time; a run in progress
 * lives in the page's content script, and a model call interrupted by a restart
 * shows up there as a dropped port and is retried.
 */
import { runTask, type LlmTask, type TaskConfig } from '../llm/tasks.ts';
import { LlmError, RunStopped } from '../shared/errors.ts';
import { detectLanguage } from '../shared/i18n.ts';
import {
  LLM_PORT,
  runKey,
  runKeyPrefix,
  type FrameMessage,
  type FrameRunState,
  type LlmPortRequest,
  type LlmPortResponse,
  type StartResponse,
  type WorkerMessage,
} from '../shared/protocol.ts';
import { PROVIDERS } from '../shared/providers.ts';
import { activeProvider, loadSettings, type StorageLike } from '../shared/settings.ts';
import { emptyUsage } from '../shared/types.ts';

const storage = chrome.storage as unknown as StorageLike;

/** How long frames get to wind down after Stop before being marked stopped. */
const STOP_GRACE_MS = 2000;
const KEEP_ALIVE_MS = 20_000;
const QUICK_QUERY_SCRIPT = 'quick-query';

// Content scripts have no business reading the key or the profile from storage.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.storage.sync.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

async function taskConfig(): Promise<TaskConfig> {
  const settings = await loadSettings(storage);
  const { id, apiKey, model } = activeProvider(settings);
  return {
    provider: PROVIDERS[id],
    model,
    apiKey,
    profile: settings.profile,
    // Swedish locale formats as YYYY-MM-DD in the user's own time zone.
    today: new Date().toLocaleDateString('sv'),
  };
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

async function frameKeys(tabId: number): Promise<string[]> {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all).filter((key) => key.startsWith(runKeyPrefix(tabId)));
}

async function clearRun(tabId: number): Promise<void> {
  await chrome.storage.session.remove(await frameKeys(tabId));
}

function stoppedState(runId: string): FrameRunState {
  return {
    runId,
    phase: 'done',
    done: 0,
    total: 0,
    report: { status: 'stopped', outcomes: [], usage: emptyUsage(), passes: 0, durationMs: 0 },
  };
}

async function startRun(tabId: number): Promise<StartResponse> {
  const settings = await loadSettings(storage);
  if (!settings.profile.trim()) return { ok: false, code: 'no-profile' };
  if (!activeProvider(settings).apiKey) return { ok: false, code: 'no-key' };

  await clearRun(tabId);

  let frames: number[];
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['fill.js'],
    });
    frames = injected.map((result) => result.frameId);
  } catch (error) {
    return {
      ok: false,
      code: 'restricted-page',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const runId = crypto.randomUUID();
  const initial: FrameRunState = { runId, phase: 'running', done: 0, total: 0 };
  await chrome.storage.session.set(
    Object.fromEntries(frames.map((frameId) => [runKey(tabId, frameId), initial]))
  );

  const message: FrameMessage = {
    type: 'fill/start',
    runId,
    overwrite: settings.overwrite,
    language: settings.language ?? detectLanguage(navigator.language),
  };
  for (const frameId of frames) {
    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() =>
      chrome.storage.session.set({ [runKey(tabId, frameId)]: stoppedState(runId) })
    );
  }
  return { ok: true, runId };
}

async function stopRun(tabId: number): Promise<void> {
  const message: FrameMessage = { type: 'fill/stop' };
  await chrome.tabs.sendMessage(tabId, message).catch(() => {});

  // A frame that died mid-run cannot report; do not leave the popup spinning.
  setTimeout(async () => {
    const all = await chrome.storage.session.get(null);
    for (const [key, state] of Object.entries(all)) {
      const frame = state as FrameRunState;
      if (key.startsWith(runKeyPrefix(tabId)) && frame.phase === 'running') {
        await chrome.storage.session.set({ [key]: stoppedState(frame.runId) });
      }
    }
  }, STOP_GRACE_MS);
}

/* ------------------------------------------------------------------ */
/* Quick Query                                                         */
/* ------------------------------------------------------------------ */

/** Registered only while enabled, so a disabled feature injects nothing anywhere. */
async function syncQuickQuery(activeTabId?: number): Promise<void> {
  const { quickQuery } = await loadSettings(storage);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [QUICK_QUERY_SCRIPT] });

  if (quickQuery && registered.length === 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: QUICK_QUERY_SCRIPT,
        js: ['quick-query.js'],
        matches: ['<all_urls>'],
        allFrames: true,
        runAt: 'document_idle',
      },
    ]);
  } else if (!quickQuery && registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [QUICK_QUERY_SCRIPT] });
  }

  if (quickQuery && activeTabId !== undefined) {
    // Pages already open missed the registration; cover the one in front.
    await chrome.scripting
      .executeScript({ target: { tabId: activeTabId, allFrames: true }, files: ['quick-query.js'] })
      .catch(() => {});
  }
  if (!quickQuery) {
    const message: FrameMessage = { type: 'quick-query/disable' };
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message: WorkerMessage, sender, sendResponse) => {
  // Starting and stopping runs belongs to the extension's own UI.
  const fromExtensionPage = sender.origin === new URL(chrome.runtime.getURL('')).origin;

  switch (message.type) {
    case 'run/start':
      if (!fromExtensionPage) return false;
      startRun(message.tabId).then(sendResponse);
      return true;

    case 'run/stop':
      if (!fromExtensionPage) return false;
      stopRun(message.tabId).then(() => sendResponse({ ok: true }));
      return true;

    case 'quick-query/sync':
      if (!fromExtensionPage) return false;
      syncQuickQuery(message.activeTabId).then(() => sendResponse({ ok: true }));
      return true;

    case 'quick-query/config':
      loadSettings(storage).then((settings) =>
        sendResponse({ language: settings.language ?? detectLanguage(navigator.language) })
      );
      return true;

    case 'run/update':
      if (sender.tab?.id !== undefined && sender.frameId !== undefined) {
        chrome.storage.session.set({ [runKey(sender.tab.id, sender.frameId)]: message.state });
      }
      return false;

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ */
/* Model calls                                                         */
/* ------------------------------------------------------------------ */

/** An extension API call resets Chrome's idle timer while a call is in flight. */
function keepAlive(): () => void {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), KEEP_ALIVE_MS);
  return () => clearInterval(timer);
}

function toErrorResponse(error: unknown): LlmPortResponse {
  return {
    ok: false,
    error: {
      code: error instanceof LlmError ? error.code : 'internal',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

async function handleTask(task: LlmTask, signal: AbortSignal): Promise<LlmPortResponse> {
  const stop = keepAlive();
  try {
    const { value, usage } = await runTask(await taskConfig(), task, signal);
    return { ok: true, value, usage };
  } catch (error) {
    return toErrorResponse(error);
  } finally {
    stop();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== LLM_PORT) return;

  // Disconnecting is how a frame cancels: Stop aborts the fetch in flight.
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort(new RunStopped()));

  port.onMessage.addListener(({ task }: LlmPortRequest) => {
    handleTask(task, controller.signal).then((response) => {
      if (!controller.signal.aborted) port.postMessage(response);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  syncQuickQuery();
});

chrome.runtime.onStartup.addListener(() => {
  syncQuickQuery();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearRun(tabId);
});

// A report describes one page; it means nothing once the tab has moved on.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) clearRun(tabId);
});

