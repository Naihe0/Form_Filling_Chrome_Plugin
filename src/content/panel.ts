/**
 * The status panel shown on the page. Lives in a closed shadow root so neither
 * the page's CSS nor its scripts reach it, and carries the attribute that makes
 * every scan ignore it.
 */
import { OVERLAY_ATTR } from '../dom/scan.ts';
import { t } from '../shared/i18n.ts';

export interface PanelItem {
  label: string;
  detail: string;
  onClick: () => void;
}

const CSS = `
  :host { all: initial; }
  .panel {
    position: fixed; right: 16px; bottom: 16px;
    z-index: 2147483647; max-width: min(420px, calc(100vw - 32px));
    background: rgba(17, 24, 39, 0.94); color: #fff; border-radius: 10px;
    padding: 12px 16px; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .row { display: flex; align-items: flex-start; gap: 12px; }
  .text { flex: 1; overflow-wrap: anywhere; }
  .close {
    all: unset; cursor: pointer; color: #9ca3af; font-size: 18px; line-height: 1; padding: 0 2px;
  }
  .close:hover, .close:focus-visible { color: #fff; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; max-height: 180px; overflow-y: auto; }
  li button {
    all: unset; display: block; box-sizing: border-box; width: 100%; cursor: pointer;
    padding: 4px 6px; border-radius: 6px; overflow-wrap: anywhere;
  }
  li button:hover, li button:focus-visible { background: rgba(255, 255, 255, 0.12); }
  .detail { color: #fca5a5; margin-left: 6px; font-size: 12px; }
`;

export class StatusPanel {
  private host: HTMLElement;
  private text: HTMLElement;
  private list: HTMLElement;
  private timer = 0;

  constructor() {
    this.host = document.createElement('div');
    this.host.setAttribute(OVERLAY_ATTR, '');
    const shadow = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'status');

    const row = document.createElement('div');
    row.className = 'row';
    this.text = document.createElement('div');
    this.text.className = 'text';

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('panelClose'));
    close.addEventListener('click', () => this.remove());

    this.list = document.createElement('ul');
    this.list.hidden = true;

    row.append(this.text, close);
    panel.append(row, this.list);
    shadow.append(style, panel);
    document.documentElement.append(this.host);
  }

  /** Shows a message; a timed one counts seconds so slow calls look alive. */
  setStatus(message: string, timed = false): void {
    clearInterval(this.timer);
    this.text.textContent = message;
    if (timed) {
      const started = Date.now();
      this.timer = window.setInterval(() => {
        this.text.textContent = `${message} (${Math.round((Date.now() - started) / 1000)}s)`;
      }, 1000);
    }
  }

  setItems(items: PanelItem[]): void {
    this.list.replaceChildren(
      ...items.map((item) => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.textContent = item.label;
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = item.detail;
        button.append(detail);
        button.addEventListener('click', item.onClick);
        row.append(button);
        return row;
      })
    );
    this.list.hidden = items.length === 0;
  }

  /** Removes the panel after a delay, unless there is something to read. */
  removeAfter(ms: number): void {
    clearInterval(this.timer);
    window.setTimeout(() => this.remove(), ms);
  }

  remove(): void {
    clearInterval(this.timer);
    this.host.remove();
  }
}
