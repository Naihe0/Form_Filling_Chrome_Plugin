/**
 * The real PageDriver. Everything the harness does to a page passes through
 * here, which is what makes the policy enforceable: this class refuses blocked
 * fields and forbidden clicks no matter who asked.
 */
import { classifyField, forbiddenClick } from '../harness/policy.ts';
import type {
  ActionResult,
  FieldReading,
  MarkStatus,
  PageDriver,
  WidgetElement,
  WidgetView,
} from '../harness/types.ts';
import type { PageSnapshot } from '../shared/types.ts';
import {
  checkInput,
  clickLikeUser,
  clickTarget,
  pause,
  pressKey,
  readText,
  selectOption,
  waitForQuiet,
  writeText,
} from './actuate.ts';
import {
  customOptionSelected,
  OVERLAY_ATTR,
  RefRegistry,
  scanPage,
  stateFingerprint,
  widgetDisplay,
  type FieldBinding,
} from './scan.ts';
import { collapse, commonAncestor, isDisplayed, isRendered, visibleText } from './text.ts';

const POPUP_ROLES = '[role="listbox"], [role="menu"], [role="tree"], [role="grid"], [role="dialog"]';
const POPUP_CLASS_HINT = /dropdown|popup|popper|popover|overlay|picker|calendar|cascader|listbox|menu/i;
const CLICKABLE_ROLES = new Set(['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'gridcell', 'button', 'radio', 'checkbox', 'link', 'tab']);
const CLICKABLE_TAGS = new Set(['BUTTON', 'A', 'TD', 'LI']);
const MARK_STYLES: Record<Exclude<MarkStatus, 'clear'>, string> = {
  working: '2px solid #f59e0b',
  filled: '2px solid #16a34a',
  attention: '2px solid #dc2626',
};
/** How long the green "filled" outline stays before the form goes back to normal. */
const FILLED_MARK_MS = 1500;

function isPositioned(el: Element): boolean {
  const { position } = getComputedStyle(el);
  return position === 'absolute' || position === 'fixed';
}

function roleOf(el: HTMLElement): string {
  // Typeable beats any ARIA role: <input role="combobox"> is still a search box.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return 'input';
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  if (el.tagName === 'BUTTON') return 'button';
  if (el.tagName === 'A') return 'link';
  if (el.tagName === 'TD') return 'cell';
  if (el.tagName === 'LI') return 'option';
  return 'item';
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true
    || el.getAttribute('aria-disabled') === 'true'
    || /(^|[-_\s])disabled($|[-_\s])/i.test(typeof el.className === 'string' ? el.className : '');
}

function blockReason(el: HTMLElement) {
  return classifyField({
    type: (el as HTMLInputElement).type,
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.id,
    placeholder: el.getAttribute('placeholder') ?? '',
    label: el.getAttribute('aria-label') ?? '',
  });
}

function clickTraits(el: HTMLElement) {
  return {
    tag: el.tagName,
    type: (el as HTMLButtonElement).type,
    role: el.getAttribute('role') ?? undefined,
    text: visibleText(el),
    href: el.getAttribute('href') ?? undefined,
    implicitSubmit:
      el instanceof HTMLButtonElement && !el.getAttribute('type') && !!el.form,
  };
}

export class DomPageDriver implements PageDriver {
  private registry = new RefRegistry();
  private bindings = new Map<string, FieldBinding>();
  private elements = new Map<string, WeakRef<HTMLElement>>();
  private marked = new Map<string, { el: HTMLElement; outline: string; offset: string; timer?: number }>();
  private tracker: { fieldId: string; observer: MutationObserver; mutated: Set<Element> } | null = null;
  private doc: Document;

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  async snapshot(): Promise<PageSnapshot> {
    const bindings = scanPage(this.registry, this.doc);
    this.bindings = new Map(bindings.map((binding) => [binding.view.id, binding]));
    return {
      title: this.doc.title,
      host: this.doc.location?.hostname ?? '',
      fields: bindings.map((binding) => binding.view),
    };
  }

  private live(fieldId: string): FieldBinding | null {
    const binding = this.bindings.get(fieldId);
    return binding && binding.el.isConnected ? binding : null;
  }

  async fillText(fieldId: string, text: string): Promise<ActionResult> {
    const binding = this.live(fieldId);
    if (!binding) return { ok: false, code: 'stale' };
    if (binding.view.blocked) return { ok: false, code: 'forbidden', detail: binding.view.blocked };

    const { maxLength } = binding.view;
    await writeText(binding.el, maxLength ? text.slice(0, maxLength) : text);
    return { ok: true };
  }

  async selectOptions(fieldId: string, optionIds: string[]): Promise<ActionResult> {
    const binding = this.live(fieldId);
    if (!binding) return { ok: false, code: 'stale' };
    if (binding.view.blocked) return { ok: false, code: 'forbidden', detail: binding.view.blocked };

    for (const optionId of optionIds) {
      const option = binding.options?.find((candidate) => candidate.id === optionId);
      if (!option) return { ok: false, code: 'not-found', detail: optionId };

      if (option.input instanceof HTMLOptionElement) {
        selectOption(binding.el as HTMLSelectElement, option.input);
      } else if (option.input) {
        await checkInput(option.input, option.face);
      } else {
        // A custom option: the driver is the last line of defence on its clicks.
        if (customOptionSelected(option.face) !== true) {
          const clicked = this.guardedClick(option.face);
          if (!clicked.ok) return clicked;
          await pause(60);
        }
      }
    }
    return { ok: true };
  }

  async readField(fieldId: string): Promise<FieldReading> {
    const binding = this.bindings.get(fieldId);
    if (!binding || !binding.el.isConnected || !isRendered(binding.el)) {
      // A hidden native radio is still "there" if its visible proxy is.
      const proxied = binding?.options?.some((option) => option.face.isConnected && isDisplayed(option.face));
      if (!proxied) return { exists: false, value: '', selected: null };
    }
    const { view, el, options } = binding!;

    if (view.kind === 'widget') {
      return { exists: true, value: widgetDisplay(el), selected: null };
    }
    if (view.kind === 'text') {
      return { exists: true, value: readText(el), selected: null };
    }

    let unknown = false;
    const selected: string[] = [];
    for (const option of options ?? []) {
      if (option.input instanceof HTMLOptionElement) {
        if (option.input.selected) selected.push(option.id);
      } else if (option.input) {
        if (option.input.checked) selected.push(option.id);
      } else {
        const state = customOptionSelected(option.face);
        const changed = option.baseline !== undefined && stateFingerprint(option.face) !== option.baseline;
        if (state === true || changed) selected.push(option.id);
        else if (state === null) unknown = true;
      }
    }
    return { exists: true, value: '', selected: unknown && selected.length === 0 ? null : selected };
  }

  /* ---------------------------------------------------------------- */
  /* Widgets                                                           */
  /* ---------------------------------------------------------------- */

  private startTracking(fieldId: string): void {
    if (this.tracker?.fieldId === fieldId) return;
    this.tracker?.observer.disconnect();

    const mutated = new Set<Element>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element) {
          mutated.add(record.target);
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && !node.hasAttribute(OVERLAY_ATTR)) mutated.add(node);
        }
      }
    });
    observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded'],
    });
    this.tracker = { fieldId, observer, mutated };
  }

  /**
   * Popups rarely live inside the field; frameworks portal them to <body>. So
   * instead of a per-framework class list, look for what appeared or changed
   * since the interaction started, and what ARIA says the field controls.
   */
  private findPopups(field: HTMLElement): HTMLElement[] {
    const found = new Set<HTMLElement>();
    const consider = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.closest(`[${OVERLAY_ATTR}]`) || el.contains(field) || field.contains(el)) return;
      if (isDisplayed(el)) found.add(el);
    };

    const owners = [field, ...Array.from(field.querySelectorAll('[aria-controls], [aria-owns]'))];
    for (const owner of owners) {
      for (const attr of ['aria-controls', 'aria-owns']) {
        for (const id of (owner.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
          consider(this.doc.getElementById(id));
        }
      }
    }

    const mutated = this.tracker?.mutated ?? new Set<Element>();
    for (const el of Array.from(this.doc.querySelectorAll(POPUP_ROLES))) {
      if (mutated.has(el) || isPositioned(el)) consider(el);
    }
    for (const el of mutated) {
      if (!el.isConnected) continue;
      // Climb to the panel itself; the mutation may be deep inside it.
      let panel: Element | null = el;
      while (panel && panel !== this.doc.body && !isPositioned(panel)) panel = panel.parentElement;
      if (panel && panel !== this.doc.body) consider(panel);
      else if (POPUP_CLASS_HINT.test(typeof el.className === 'string' ? el.className : '')) consider(el);
    }

    const list = [...found];
    return list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
  }

  private elementRef(el: HTMLElement): string {
    const ref = this.registry.idFor(el, 'e');
    this.elements.set(ref, new WeakRef(el));
    return ref;
  }

  private collectFrom(root: HTMLElement, popup: boolean, seen: Set<HTMLElement>, out: WidgetElement[]): void {
    const visit = (el: HTMLElement) => {
      if (seen.has(el) || !isRendered(el)) return;
      const role = el.getAttribute('role');
      const isInput = el instanceof HTMLInputElement && !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type);
      const text = visibleText(el, 120);
      const interactive = isInput
        || el instanceof HTMLTextAreaElement
        || (!!role && CLICKABLE_ROLES.has(role))
        || (CLICKABLE_TAGS.has(el.tagName) && (!!text || el.tagName === 'BUTTON'))
        || el.hasAttribute('onclick')
        || (!!text && text.length <= 80 && el.childElementCount <= 3 && getComputedStyle(el).cursor === 'pointer');

      const allowed = !forbiddenClick(clickTraits(el)) && !(isInput && blockReason(el));
      if (interactive && isDisplayed(el) && allowed) {
        // One row per visible choice for the model. The click itself is aimed
        // deeper, by clickTarget.
        seen.add(el);
        const selected = el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true';
        out.push({
          ref: this.elementRef(el),
          role: roleOf(el),
          text,
          ...(popup ? { popup: true } : {}),
          ...(selected ? { selected: true } : {}),
          ...(isDisabled(el) ? { disabled: true } : {}),
          ...(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? { value: el.value } : {}),
        });
        if (!isInput && el.childElementCount > 0 && text) {
          const children = Array.from(el.children) as HTMLElement[];
          const nested = children.filter((child) => child.matches('button, a, input, [role]'));
          nested.forEach(visit);
          return;
        }
      }
      for (const child of Array.from(el.children)) visit(child as HTMLElement);
    };
    visit(root);
  }

  async widgetView(fieldId: string): Promise<WidgetView | null> {
    const binding = this.live(fieldId);
    if (!binding) return null;
    const field = binding.el;
    this.startTracking(fieldId);

    const elements: WidgetElement[] = [];
    const seen = new Set<HTMLElement>();

    elements.push({
      ref: this.elementRef(field),
      role: roleOf(field),
      text: visibleText(field, 120),
      trigger: true,
      ...(field instanceof HTMLInputElement ? { value: field.value } : {}),
    });
    seen.add(field);
    for (const child of Array.from(field.children)) {
      this.collectFrom(child as HTMLElement, false, seen, elements);
    }

    const popups = this.findPopups(field);
    for (const popup of popups) this.collectFrom(popup, true, seen, elements);

    const popupText = collapse(popups.map((popup) => visibleText(popup, 800)).join(' ')).slice(0, 1200);
    const expanded = field.getAttribute('aria-expanded') === 'true'
      || !!field.querySelector('[aria-expanded="true"]');

    return {
      fieldId,
      display: widgetDisplay(field),
      open: expanded || elements.some((element) => element.popup),
      elements,
      popupText,
    };
  }

  private resolve(ref: string): HTMLElement | null {
    const el = this.elements.get(ref)?.deref();
    return el?.isConnected ? el : null;
  }

  /** Clicks what the policy allows. Both ends are checked: a harmless <li> can wrap an exit link. */
  private guardedClick(el: HTMLElement): ActionResult {
    const target = clickTarget(el);
    const reason = forbiddenClick(clickTraits(el)) ?? forbiddenClick(clickTraits(target));
    if (reason) return { ok: false, code: 'forbidden', detail: reason };
    clickLikeUser(target);
    return { ok: true };
  }

  async widgetClick(ref: string): Promise<ActionResult> {
    const el = this.resolve(ref);
    if (!el) return { ok: false, code: 'stale' };
    return this.guardedClick(el);
  }

  async widgetType(ref: string, text: string): Promise<ActionResult> {
    let el = this.resolve(ref);
    if (!el) return { ok: false, code: 'stale' };
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      el = el.querySelector('input:not([type="hidden"]), textarea') ?? el;
    }
    if ((el as HTMLInputElement).readOnly) return { ok: false, code: 'readonly' };
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.isContentEditable) {
      return { ok: false, code: 'rejected', detail: 'not editable' };
    }
    const blocked = blockReason(el);
    if (blocked) return { ok: false, code: 'forbidden', detail: blocked };

    // Keep focus: blurring a search box closes the very popup it filters.
    el.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.select?.();
      if (!this.doc.execCommand('insertText', false, text) || el.value !== text) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      }
    } else {
      await writeText(el, text);
    }
    return { ok: true };
  }

  async widgetPress(ref: string, key: string): Promise<ActionResult> {
    const el = this.resolve(ref);
    if (!el) return { ok: false, code: 'stale' };
    // Enter in a form field can submit the form; let only a widget's own handlers see it.
    const form = (el as HTMLInputElement).form ?? el.closest('form');
    const blockSubmit = (event: Event) => event.preventDefault();
    if (key === 'Enter') form?.addEventListener('submit', blockSubmit, { capture: true, once: true });
    pressKey(el, key);
    await pause(30);
    form?.removeEventListener('submit', blockSubmit, { capture: true });
    return { ok: true };
  }

  async closeWidget(fieldId: string): Promise<void> {
    const binding = this.live(fieldId);
    try {
      if (binding && this.findPopups(binding.el).length > 0) {
        pressKey(binding.el, 'Escape');
        await waitForQuiet(this.doc.documentElement, 80, 400);

        if (this.findPopups(binding.el).length > 0) {
          // Click-outside handlers close most of what Escape does not.
          clickLikeUser(this.doc.body);
          await waitForQuiet(this.doc.documentElement, 80, 400);
        }
      }
      binding?.el.blur?.();
    } finally {
      this.tracker?.observer.disconnect();
      this.tracker = null;
    }
  }

  settle(): Promise<void> {
    return waitForQuiet(this.doc.documentElement);
  }

  /* ---------------------------------------------------------------- */
  /* User-facing marks                                                 */
  /* ---------------------------------------------------------------- */

  /** A group is marked as a whole; outlining one option would look like choosing it. */
  private markTarget(binding: FieldBinding): HTMLElement {
    if (binding.view.kind === 'select') return binding.el;
    const faces = binding.options?.map((option) => option.face) ?? [];
    const target = faces.length > 1 ? commonAncestor(faces) : faces[0];
    return target instanceof HTMLElement ? target : binding.el;
  }

  mark(fieldId: string, status: MarkStatus): void {
    const binding = this.bindings.get(fieldId);
    if (!binding) return;
    const el = this.markTarget(binding);

    const previous = this.marked.get(fieldId);
    if (previous?.timer) clearTimeout(previous.timer);

    const entry = previous ?? { el, outline: el.style.outline, offset: el.style.outlineOffset };
    const restore = () => {
      entry.el.style.outline = entry.outline;
      entry.el.style.outlineOffset = entry.offset;
      this.marked.delete(fieldId);
    };

    if (status === 'clear') {
      restore();
      return;
    }
    el.style.outline = MARK_STYLES[status];
    el.style.outlineOffset = '1px';
    this.marked.set(fieldId, entry);
    if (status === 'filled') entry.timer = window.setTimeout(restore, FILLED_MARK_MS);
  }

  scrollToField(fieldId: string): void {
    const binding = this.bindings.get(fieldId);
    if (binding) this.markTarget(binding).scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  clearMarks(): void {
    for (const fieldId of [...this.marked.keys()]) this.mark(fieldId, 'clear');
  }
}
