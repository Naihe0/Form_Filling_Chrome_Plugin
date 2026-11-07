/**
 * Quick Query: end a text with ``` or ··· to have the model continue it.
 * Registered on every page while enabled, so it stays small and does nothing
 * until the trigger is typed.
 */
import { writeText } from '../dom/actuate.ts';
import { nameOf } from '../dom/scan.ts';
import { classifyField } from '../harness/policy.ts';
import { RunStopped } from '../shared/errors.ts';
import { setLanguage, t } from '../shared/i18n.ts';
import type { FrameMessage, WorkerMessage } from '../shared/protocol.ts';
import type { Language } from '../shared/settings.ts';
import { callTask } from './llm-client.ts';
import { StatusPanel } from './panel.ts';

declare global {
  interface Window {
    __affQuickQueryInstalled?: boolean;
  }
}

const TRIGGERS = ['```', '···'];
const ERROR_LINGER_MS = 6000;

function editableTarget(event: Event): HTMLElement | null {
  const target = event.composedPath()[0];
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && (target.type === 'text' || target.type === '' || target.type === 'search')) {
    return target;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return target;
  return null;
}

const readRaw = (el: HTMLElement) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.innerText;

function install(): void {
  const busy = new WeakSet<HTMLElement>();

  const query = async (el: HTMLElement, original: string, typed: string) => {
    busy.add(el);
    const config: { language: Language } = await chrome.runtime.sendMessage({
      type: 'quick-query/config',
    } satisfies WorkerMessage);
    setLanguage(config.language);

    const panel = new StatusPanel();
    panel.setStatus(t('queryGenerating'), true);
    const controller = new AbortController();

    try {
      const { value } = await callTask<string>(
        {
          kind: 'quick-query',
          request: { text: typed, label: nameOf(el).label, title: document.title },
        },
        controller.signal
      );
      // The model takes seconds. If the user kept typing, their text comes first.
      if (readRaw(el) === original) {
        await writeText(el, typed + value);
        el.focus();
      }
      panel.remove();
    } catch (error) {
      if (error instanceof RunStopped) {
        panel.remove();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(t('queryFailed', { message }));
        panel.removeAfter(ERROR_LINGER_MS);
      }
    } finally {
      busy.delete(el);
    }
  };

  const onInput = (event: Event) => {
    const el = editableTarget(event);
    if (!el || busy.has(el)) return;

    const text = readRaw(el);
    const trigger = TRIGGERS.find((candidate) => text.endsWith(candidate));
    if (!trigger) return;

    // Never send what is typed into a password or payment box to a model.
    const blocked = classifyField({
      type: (el as HTMLInputElement).type,
      autocomplete: el.getAttribute('autocomplete') ?? '',
      name: el.getAttribute('name') ?? '',
      id: el.id,
      label: nameOf(el).label,
    });
    if (blocked) return;

    void query(el, text, text.slice(0, -trigger.length));
  };

  document.addEventListener('input', onInput, true);

  chrome.runtime.onMessage.addListener((message: FrameMessage) => {
    if (message.type === 'quick-query/disable') {
      document.removeEventListener('input', onInput, true);
      window.__affQuickQueryInstalled = false;
    }
  });
}

if (!window.__affQuickQueryInstalled) {
  window.__affQuickQueryInstalled = true;
  install();
}
