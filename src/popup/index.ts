/**
 * Popup: settings on one side, the current tab's run on the other.
 * Run state comes from chrome.storage.session, so closing and reopening the
 * popup mid-run picks up where things are.
 */
import {
  detailMessage,
  detectLanguage,
  errorMessage,
  getLanguage,
  setLanguage,
  t,
  type MessageKey,
} from '../shared/i18n.ts';
import {
  runKeyPrefix,
  type FrameRunState,
  type StartResponse,
  type WorkerMessage,
} from '../shared/protocol.ts';
import { isProviderId, PROVIDERS, PROVIDER_IDS, type ProviderId } from '../shared/providers.ts';
import {
  loadSettings,
  saveProfile,
  saveSettings,
  type Settings,
  type StorageLike,
} from '../shared/settings.ts';
import type { FieldOutcome, RunReport } from '../shared/types.ts';

const storage = chrome.storage as unknown as StorageLike;
const STATUS_MS = 3500;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const ui = {
  tabBar: byId('tabBar'),
  tabProfile: byId('tabProfile'),
  tabFill: byId('tabFill'),
  viewProfile: byId('viewProfile'),
  viewFill: byId('viewFill'),
  viewRunning: byId('viewRunning'),
  viewReport: byId('viewReport'),
  profile: byId<HTMLTextAreaElement>('profile'),
  saveProfile: byId('saveProfile'),
  provider: byId<HTMLSelectElement>('provider'),
  model: byId<HTMLInputElement>('model'),
  apiKey: byId<HTMLInputElement>('apiKey'),
  overwrite: byId<HTMLInputElement>('overwrite'),
  quickQuery: byId<HTMLInputElement>('quickQuery'),
  start: byId('start'),
  stop: byId('stop'),
  back: byId('back'),
  progress: byId('progress'),
  reportTitle: byId('reportTitle'),
  reportSummary: byId('reportSummary'),
  reportList: byId<HTMLUListElement>('reportList'),
  reportUsage: byId('reportUsage'),
  status: byId('status'),
  langEn: byId('langEn'),
  langZh: byId('langZh'),
};

let settings: Settings;
let tabId: number | undefined;
let activeTab: 'profile' | 'fill' = 'fill';
let frames: FrameRunState[] = [];
let statusTimer = 0;

function showStatus(message: string, isError = false): void {
  clearTimeout(statusTimer);
  ui.status.textContent = message;
  ui.status.className = isError ? 'status error' : 'status';
  statusTimer = window.setTimeout(() => {
    ui.status.textContent = '';
  }, STATUS_MS);
}

function applyI18n(): void {
  document.documentElement.lang = getLanguage() === 'zh_CN' ? 'zh-CN' : 'en';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as MessageKey);
  });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder as MessageKey);
  });
  ui.langEn.classList.toggle('active', getLanguage() === 'en');
  ui.langZh.classList.toggle('active', getLanguage() === 'zh_CN');
  ui.langEn.setAttribute('aria-pressed', String(getLanguage() === 'en'));
  ui.langZh.setAttribute('aria-pressed', String(getLanguage() === 'zh_CN'));
  renderProviderFields();
  render();
}

function renderProviderFields(): void {
  const id = ui.provider.value as ProviderId;
  const config = settings.providers[id];
  ui.model.value = config?.model ?? '';
  ui.model.placeholder = t('modelIdPlaceholder', { model: PROVIDERS[id].defaultModel });
  ui.apiKey.value = config?.apiKey ?? '';
}

/* ------------------------------------------------------------------ */
/* Rendering run state                                                 */
/* ------------------------------------------------------------------ */

const needsAttention = (outcome: FieldOutcome): boolean =>
  outcome.status === 'failed' || outcome.status === 'blocked' || outcome.status === 'unconfirmed'
  || (outcome.status === 'skipped' && outcome.required);

function worstStatus(reports: RunReport[]): RunReport['status'] {
  const order: Array<RunReport['status']> = ['failed', 'budget-exhausted', 'stopped', 'completed'];
  return order.find((status) => reports.some((report) => report.status === status)) ?? 'completed';
}

function renderReport(reports: RunReport[]): void {
  const outcomes = reports.flatMap((report) => report.outcomes);
  const status = worstStatus(reports);
  const failure = reports.find((report) => report.error)?.error;
  const titles: Record<RunReport['status'], MessageKey> = {
    completed: 'reportTitleCompleted',
    stopped: 'reportTitleStopped',
    failed: 'reportTitleFailed',
    'budget-exhausted': 'reportTitleBudget',
  };

  const filled = outcomes.filter((outcome) => outcome.status === 'filled').length;
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;

  if (outcomes.length === 0 && status === 'completed') {
    ui.reportTitle.textContent = t('reportNoFields');
  } else if (status === 'failed' && failure) {
    ui.reportTitle.textContent = `${t(titles.failed)} ${errorMessage(failure)}`;
  } else {
    ui.reportTitle.textContent = t(titles[status]);
  }
  ui.reportTitle.classList.toggle('error', status === 'failed');

  ui.reportSummary.textContent =
    outcomes.length === 0
      ? ''
      : [t('reportFilled', { count: filled }), skipped ? t('reportSkipped', { count: skipped }) : '']
          .filter(Boolean)
          .join(' · ');

  const attention = outcomes.filter(needsAttention);
  ui.reportList.replaceChildren(
    ...attention.map((outcome) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'report-label';
      label.textContent = outcome.label;
      const detail = document.createElement('span');
      detail.className = 'report-detail';
      detail.textContent = detailMessage(outcome.detail);
      item.append(label, detail);
      return item;
    })
  );
  byId('reportAttention').hidden = attention.length === 0;

  const calls = reports.reduce((sum, report) => sum + report.usage.calls, 0);
  const tokens = reports.reduce((sum, report) => sum + report.usage.totalTokens, 0);
  const longest = Math.max(0, ...reports.map((report) => report.durationMs));
  ui.reportUsage.textContent = calls
    ? t('reportUsage', { calls, tokens: tokens.toLocaleString(), seconds: Math.round(longest / 1000) })
    : '';
}

function render(): void {
  const running = frames.some((frame) => frame.phase === 'running');
  const reports = frames.flatMap((frame) => (frame.report ? [frame.report] : []));
  const showReportView = !running && reports.length > 0;

  ui.tabBar.hidden = running || showReportView;
  ui.viewProfile.hidden = running || showReportView || activeTab !== 'profile';
  ui.viewFill.hidden = running || showReportView || activeTab !== 'fill';
  ui.viewRunning.hidden = !running;
  ui.viewReport.hidden = !showReportView;
  ui.tabProfile.classList.toggle('active', activeTab === 'profile');
  ui.tabFill.classList.toggle('active', activeTab === 'fill');

  if (running) {
    const done = frames.reduce((sum, frame) => sum + frame.done, 0);
    const total = frames.reduce((sum, frame) => sum + frame.total, 0);
    ui.progress.textContent = total ? t('runProgress', { done, total }) : t('runPlanning');
  } else if (showReportView) {
    renderReport(reports);
  }
}

async function refreshRun(): Promise<void> {
  if (tabId === undefined) return;
  const all = await chrome.storage.session.get(null);
  frames = Object.entries(all)
    .filter(([key]) => key.startsWith(runKeyPrefix(tabId!)))
    .map(([, state]) => state as FrameRunState);
  render();
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

async function saveProviderFields(): Promise<void> {
  const id = ui.provider.value;
  if (!isProviderId(id)) return;
  const config = { apiKey: ui.apiKey.value.trim(), model: ui.model.value.trim() };
  settings = await saveSettings(storage, (current) => ({
    provider: id,
    providers: { ...current.providers, [id]: config },
  }));
}

function send<T>(message: WorkerMessage): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function bind(): void {
  ui.tabProfile.addEventListener('click', () => {
    activeTab = 'profile';
    render();
  });
  ui.tabFill.addEventListener('click', () => {
    activeTab = 'fill';
    render();
  });

  const changeLanguage = async (language: Settings['language']) => {
    setLanguage(language!);
    settings = await saveSettings(storage, { language });
    applyI18n();
  };
  ui.langEn.addEventListener('click', () => changeLanguage('en'));
  ui.langZh.addEventListener('click', () => changeLanguage('zh_CN'));

  ui.saveProfile.addEventListener('click', async () => {
    const text = ui.profile.value.trim();
    if (!text) {
      showStatus(t('profileEmpty'), true);
      return;
    }
    const sync = await saveProfile(storage, text);
    settings = await loadSettings(storage);
    showStatus(t(sync === 'too-large' ? 'profileSavedLocal' : 'profileSaved'));
  });

  ui.provider.addEventListener('change', async () => {
    renderProviderFields();
    settings = await saveSettings(storage, { provider: ui.provider.value as ProviderId });
  });
  ui.model.addEventListener('change', saveProviderFields);
  ui.apiKey.addEventListener('change', saveProviderFields);

  ui.overwrite.addEventListener('change', async () => {
    settings = await saveSettings(storage, { overwrite: ui.overwrite.checked });
  });

  ui.quickQuery.addEventListener('change', async () => {
    await saveProviderFields();
    const enabled = ui.quickQuery.checked;
    const provider = settings.providers[settings.provider];
    if (enabled && (!settings.profile.trim() || !provider?.apiKey)) {
      ui.quickQuery.checked = false;
      showStatus(t('statusQuickQuerySetup'), true);
      return;
    }
    settings = await saveSettings(storage, { quickQuery: enabled });
    await send({ type: 'quick-query/sync', activeTabId: tabId });
  });

  ui.start.addEventListener('click', async () => {
    if (tabId === undefined) {
      showStatus(t('statusNoTab'), true);
      return;
    }
    await saveProviderFields();

    const response = await send<StartResponse>({ type: 'run/start', tabId });
    if (response.ok) {
      await refreshRun();
      return;
    }
    if (response.code === 'no-profile') {
      activeTab = 'profile';
      render();
      showStatus(t('statusNeedProfile'), true);
    } else if (response.code === 'no-key') {
      showStatus(t('statusNeedKey'), true);
    } else {
      showStatus(t('statusRestrictedPage'), true);
    }
  });

  ui.stop.addEventListener('click', () => send({ type: 'run/stop', tabId: tabId! }));

  ui.back.addEventListener('click', async () => {
    const all = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(
      Object.keys(all).filter((key) => key.startsWith(runKeyPrefix(tabId!)))
    );
    await refreshRun();
  });

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'session') {
      void refreshRun();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

async function init(): Promise<void> {
  settings = await loadSettings(storage);
  setLanguage(settings.language ?? detectLanguage(navigator.language));

  for (const id of PROVIDER_IDS) {
    ui.provider.add(new Option(PROVIDERS[id].name, id));
  }
  ui.provider.value = settings.provider;
  ui.profile.value = settings.profile;
  ui.overwrite.checked = settings.overwrite;
  ui.quickQuery.checked = settings.quickQuery;

  // ?tab= lets the popup be opened in a page of its own, as the E2E tests do.
  const requested = Number(new URLSearchParams(location.search).get('tab'));
  if (requested) {
    tabId = requested;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }

  bind();
  applyI18n();
  await refreshRun();
  document.body.dataset.ready = 'true';
}

void init();
