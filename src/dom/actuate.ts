/**
 * Execution: the low-level ways of changing a control so that the page's
 * framework notices. Each write has a fallback, because React, Vue, input masks
 * and custom widgets each ignore something different.
 */
import { collapse, isRendered, visibleText } from './text.ts';

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The element to dispatch a click on. Events bubble up but never down, and a
 * handler may sit on any wrapper around the text (Element Plus triggers and Ant
 * Design tree nodes both do this), so aim for the deepest element showing the
 * same text: every handler above it still fires.
 */
export function clickTarget(el: HTMLElement): HTMLElement {
  let target = el;
  for (;;) {
    const text = visibleText(target);
    const children = (Array.from(target.children) as HTMLElement[]).filter(isRendered);
    const candidates = text ? children.filter((child) => visibleText(child)) : children;
    if (candidates.length !== 1) return target;

    const [next] = candidates;
    if (next.matches('input, select, textarea, svg')) return target;
    if (text && visibleText(next) !== text) return target;
    target = next;
  }
}

/** Mouse-driven widgets listen on different events; send the whole gesture. */
export function clickLikeUser(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  const rect = el.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
  el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

const isTextControl = (el: HTMLElement): el is TextControl =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/**
 * Writes through the prototype's setter. React overrides `value` on the
 * instance to track changes; going around it makes the input event register.
 */
function setNativeValue(el: TextControl, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireInput(el: HTMLElement, value: string): void {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

export function readText(el: HTMLElement): string {
  return isTextControl(el) ? el.value : collapse(el.innerText ?? el.textContent ?? '');
}

/** Replaces the selection with real editing, which produces trusted input events. */
function insertViaEditing(el: HTMLElement, value: string): boolean {
  el.focus({ preventScroll: true });
  if (isTextControl(el)) {
    try {
      el.select();
    } catch {
      return false; // Some input types, such as date, have no text selection.
    }
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return document.execCommand('insertText', false, value);
}

/** Writes text and waits for controlled inputs to settle. Returns what stuck. */
export async function writeText(el: HTMLElement, value: string): Promise<string> {
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  el.focus({ preventScroll: true });

  const expected = (text: string) => collapse(text) === collapse(value);

  if (isTextControl(el)) {
    setNativeValue(el, value);
    fireInput(el, value);
    await pause(40);
    if (expected(el.value)) {
      el.blur();
      await pause(20);
      return el.value;
    }
    // A mask or framework rewrote it; maybe it wants real typing instead.
    setNativeValue(el, '');
  }

  insertViaEditing(el, value);
  await pause(40);
  el.blur();
  await pause(20);
  return readText(el);
}

const isOptionState = (input: HTMLInputElement | HTMLOptionElement): boolean =>
  input instanceof HTMLOptionElement ? input.selected : input.checked;

/** Waits for a native checked state, without re-clicking and toggling it back. */
async function becameChecked(input: HTMLInputElement, timeoutMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (input.checked) return true;
    await pause(15);
  }
  return input.checked;
}

/** Checks a radio or checkbox, starting with what a person would do. */
export async function checkInput(input: HTMLInputElement, face: HTMLElement): Promise<boolean> {
  if (input.checked) return true;

  clickLikeUser(face);
  if (await becameChecked(input)) return true;

  const label = input.labels?.[0];
  if (label && label !== face) {
    label.click();
    if (await becameChecked(input)) return true;
  }

  input.click();
  if (await becameChecked(input)) return true;

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
  setter?.call(input, true);
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return input.checked;
}

export function selectOption(select: HTMLSelectElement, option: HTMLOptionElement): boolean {
  select.focus({ preventScroll: true });
  option.selected = true;
  select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  select.blur();
  return isOptionState(option);
}

const KEY_CODES: Record<string, number> = {
  Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8,
};

export function pressKey(el: HTMLElement, key: string): void {
  const init: KeyboardEventInit & { keyCode?: number } = {
    key,
    code: key,
    keyCode: KEY_CODES[key] ?? 0,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  el.focus({ preventScroll: true });
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/** Resolves when the DOM has been quiet for a moment, or after the cap. */
export function waitForQuiet(root: Node = document.documentElement, quietMs = 120, capMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = 0;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = window.setTimeout(finish, quietMs);
    });
    const capTimer = window.setTimeout(finish, capMs);
    quietTimer = window.setTimeout(finish, quietMs);
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}
