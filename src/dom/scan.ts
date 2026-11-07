/**
 * Perception: turns the live DOM into the FieldViews the model reasons over.
 *
 * Deterministic and framework-agnostic. It uses the signals browsers and
 * assistive technology use (labels, ARIA, layout), walks open shadow roots, and
 * only offers what a user can see. Hidden inputs, CSRF tokens and honeypots
 * never reach the model because they are never scanned into a field.
 */
import { classifyField, forbiddenClick, isConsentText } from '../harness/policy.ts';
import type { FieldView, OptionView, WidgetHint } from '../shared/types.ts';
import {
  collapse,
  commonAncestor,
  composedClosest,
  isDisplayed,
  isRendered,
  isUnreachable,
  precedingText,
  textBefore,
  visibleText,
} from './text.ts';

/** Marks the extension's own UI, which every scan must ignore. */
export const OVERLAY_ATTR = 'data-aff-overlay';

export interface OptionBinding {
  id: string;
  label: string;
  /** The native control, when there is one. */
  input?: HTMLInputElement | HTMLOptionElement;
  /** What a user would click. */
  face: HTMLElement;
  /** State fingerprint at scan time; how custom options reveal a selection. */
  baseline?: string;
}

export interface FieldBinding {
  view: FieldView;
  el: HTMLElement;
  options?: OptionBinding[];
}

/** Hands out ids that stay stable across scans for as long as the element lives. */
export class RefRegistry {
  private ids = new WeakMap<object, string>();
  private counters = new Map<string, number>();
  private groups = new WeakMap<object, Map<string, object>>();

  idFor(key: object, prefix: string): string {
    let id = this.ids.get(key);
    if (!id) {
      const next = (this.counters.get(prefix) ?? 0) + 1;
      this.counters.set(prefix, next);
      id = `${prefix}${next}`;
      this.ids.set(key, id);
    }
    return id;
  }

  /** A stable identity object for a named group within a scope. */
  groupKey(scope: object, name: string): object {
    let names = this.groups.get(scope);
    if (!names) {
      names = new Map();
      this.groups.set(scope, names);
    }
    let key = names.get(name);
    if (!key) {
      key = {};
      names.set(name, key);
    }
    return key;
  }
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO']);
const NON_FIELD_INPUTS = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const NOT_FORM_REGIONS = 'nav, header, footer, aside, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="toolbar"], [role="banner"], [role="contentinfo"]';

const WIDGET_CLASS = /(^|[-_\s])(select|selection|selector|cascader|picker|datepicker|date-editor|calendar|autocomplete|combobox|dropdown)($|[-_\s\d])/i;
const DATE_HINT = /date|calendar|birthday|生日|日期/i;
const PLACEHOLDER_TEXT = /^(please\s+)?(select|choose|pick)\b|^--|请选择|请输入|选择/i;
const STATE_CLASS = /^(is-)?(active|selected|checked|on|current|focus|focused|hover|open)$|--(selected|active|checked)$/i;
const SELECTED_CLASS = /(^|[-_\s])(selected|checked|active|on)($|[-_\s])/i;
const REQUIRED_MARK = /^[*＊]\s*|\s*[*＊]$/g;

const classOf = (el: Element): string => (typeof el.className === 'string' ? el.className : '');

function requiredMark(text: string): boolean {
  return /^[*＊]|[*＊]$|必填/.test(text.trim());
}

function cleanLabel(text: string): string {
  return collapse(text.replace(REQUIRED_MARK, '').replace(/[:：]\s*$/, ''));
}

function textOfIds(el: Element, attr: string): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const ids = (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean);
  return collapse(
    ids.map((id) => {
      const target = root.getElementById(id);
      return target ? visibleText(target) : '';
    }).join(' ')
  );
}

/** Explicit naming: aria-labelledby, aria-label, then <label>. Empty if none. */
function explicitName(el: HTMLElement): string {
  const labelled = textOfIds(el, 'aria-labelledby');
  if (labelled) return labelled;
  const aria = collapse(el.getAttribute('aria-label') ?? '');
  if (aria) return aria;

  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) {
    const text = collapse(Array.from(labels).map((label) => visibleText(label)).join(' '));
    if (text) return text;
  }
  const wrapping = el.closest('label');
  return wrapping ? visibleText(wrapping) : '';
}

function humanize(name: string): string {
  return collapse(name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-[\].]+/g, ' '));
}

/** Name of a control from the strongest signal available, plus any weaker hints. */
export function nameOf(el: HTMLElement): { label: string; hint?: string } {
  const placeholder = collapse(el.getAttribute('placeholder') ?? '');
  const title = collapse(el.getAttribute('title') ?? '');
  const described = textOfIds(el, 'aria-describedby');
  const machineName = el.getAttribute('name') ?? el.id ?? '';
  const autocomplete = el.getAttribute('autocomplete') ?? '';

  const hints = [described, title];
  if (autocomplete && autocomplete !== 'off' && autocomplete !== 'on') {
    hints.push(`autocomplete: ${autocomplete}`);
  }

  let label = explicitName(el) || precedingText(el);
  if (label) {
    if (placeholder) hints.unshift(placeholder);
  } else {
    label = placeholder || title || humanize(machineName);
  }
  if (machineName && !/^[\d_-]*$/.test(machineName) && !/^(q|field|input)\d*$/i.test(machineName)) {
    hints.push(`name: ${humanize(machineName)}`);
  }

  const hint = collapse(hints.filter(Boolean).filter((text) => text !== label).join('; '));
  return { label, ...(hint ? { hint: hint.slice(0, 200) } : {}) };
}

function sectionOf(el: Element, heading: string): string | undefined {
  const legend = composedClosest(el, 'fieldset')?.querySelector(':scope > legend');
  return (legend && visibleText(legend)) || heading || undefined;
}

/** A search box for the site itself is not part of any form the user is filling. */
function isSiteSearch(el: HTMLElement): boolean {
  if (composedClosest(el, '[role="search"], form[action*="search" i]')) return true;
  return (el as HTMLInputElement).type === 'search' && !(el as HTMLInputElement).form;
}

/** What a user sees and clicks for a radio or checkbox, which is often not the input. */
function faceOf(input: HTMLInputElement): HTMLElement | null {
  if (isDisplayed(input) && input.getBoundingClientRect().width >= 4) return input;

  for (const label of Array.from(input.labels ?? [])) {
    if (isDisplayed(label)) return label;
  }
  let node: HTMLElement | null = input.parentElement;
  for (let level = 0; node && level < 3; level++, node = node.parentElement) {
    if (node.querySelectorAll('input[type="radio"], input[type="checkbox"]').length > 1) return null;
    if (isDisplayed(node)) return node;
  }
  return null;
}

/** Column heading for a radio in a matrix question. */
function columnHeader(input: HTMLInputElement): string {
  const cell = input.closest('td');
  const table = cell?.closest('table');
  const row = cell?.closest('tr');
  if (!cell || !table || !row) return '';
  const headerRow = table.tHead?.rows[0] ?? table.rows[0];
  if (!headerRow || headerRow === row) return '';
  return visibleText(headerRow.cells[cell.cellIndex] ?? headerRow);
}

function optionLabel(input: HTMLInputElement): string {
  const explicit = explicitName(input);
  if (explicit) return explicit;

  for (let next = input.nextSibling; next; next = next.nextSibling) {
    if (next.nodeType === Node.TEXT_NODE) {
      const text = collapse(next.nodeValue ?? '');
      if (text) return text;
    } else if (next.nodeType === Node.ELEMENT_NODE) {
      const element = next as Element;
      if (element.matches('input, select, textarea')) break;
      const text = visibleText(element);
      if (text) return text;
    }
  }

  const header = columnHeader(input);
  if (header) return header;

  const parent = input.parentElement;
  if (parent?.querySelectorAll('input').length === 1) {
    const text = visibleText(parent);
    if (text) return text;
  }
  const grand = parent?.parentElement;
  if (grand?.querySelectorAll('input').length === 1) {
    const text = visibleText(grand);
    if (text) return text;
  }
  return humanize(input.value === 'on' ? '' : input.value);
}

/** The question a group of options answers. */
function groupName(members: HTMLElement[]): { label: string; required: boolean } {
  const first = members[0];
  const required = members.some((member) => (member as HTMLInputElement).required === true
    || member.getAttribute('aria-required') === 'true');

  const container = composedClosest(first, '[role="radiogroup"], [role="group"], fieldset');
  if (container && members.every((member) => container.contains(member))) {
    const named = textOfIds(container, 'aria-labelledby') || collapse(container.getAttribute('aria-label') ?? '');
    if (named) return { label: named, required };
    const legend = container.querySelector(':scope > legend');
    if (legend) {
      const text = visibleText(legend);
      if (text) return { label: text, required: required || requiredMark(text) };
    }
  }

  // Matrix question: the row's first cell names it.
  const row = first.closest('tr');
  if (row && members.every((member) => row.contains(member))) {
    const cell = row.cells[0];
    if (cell && !cell.querySelector('input')) {
      const text = visibleText(cell);
      const table = row.closest('table');
      const question = table ? precedingText(table) : '';
      if (text) return { label: question ? `${question}: ${text}` : text, required };
    }
  }

  const ancestor = commonAncestor(members);
  if (ancestor) {
    const inner = textBefore(ancestor, first);
    const text = inner || precedingText(ancestor);
    if (text) return { label: text, required: required || requiredMark(text) };
  }
  return { label: '', required };
}

interface ScanItem {
  el: HTMLElement;
  heading: string;
}

function isWidgetRoot(el: HTMLElement): boolean {
  const role = el.getAttribute('role');
  if (role === 'combobox') return true;
  const popup = el.getAttribute('aria-haspopup');
  if (popup && /^(listbox|grid|tree|dialog|true)$/.test(popup)) return true;
  const list = el.getAttribute('aria-autocomplete');
  if (list === 'list' || list === 'both') return true;

  // A read-only input only makes sense as the trigger of some picker.
  if (el instanceof HTMLInputElement && el.readOnly && !NON_FIELD_INPUTS.has(el.type)
    && el.type !== 'radio' && el.type !== 'checkbox') {
    const placeholder = el.getAttribute('placeholder') ?? '';
    if (DATE_HINT.test(placeholder) || PLACEHOLDER_TEXT.test(placeholder)
      || getComputedStyle(el).cursor === 'pointer') return true;
  }

  if (el instanceof HTMLButtonElement || !WIDGET_CLASS.test(classOf(el))) return false;
  if (el instanceof HTMLInputElement) return !NON_FIELD_INPUTS.has(el.type) && el.type !== 'radio' && el.type !== 'checkbox';
  if (composedClosest(el, NOT_FORM_REGIONS)) return false;

  // A trigger is small and wraps at most a search box. A class like
  // "select-wrapper" on a native <select>, or on a whole form, is not a widget.
  if (el.querySelector('select, textarea, input[type="radio"], input[type="checkbox"]')) return false;
  if (el.querySelectorAll('input').length > 1) return false;
  if (!isDisplayed(el) || el.getBoundingClientRect().height > 120) return false;
  return !!el.querySelector('input') || getComputedStyle(el).cursor === 'pointer';
}

function widgetHint(el: HTMLElement, label: string): WidgetHint {
  const text = `${classOf(el)} ${el.getAttribute('placeholder') ?? ''} ${label}`;
  if (/cascader|cascade|级联/i.test(text)) return 'cascader';
  if (DATE_HINT.test(text)) return 'datepicker';
  const input = el instanceof HTMLInputElement ? el : el.querySelector('input');
  if (input && !input.readOnly) return 'search';
  return 'dropdown';
}

/** What a widget currently shows, including any hidden value it keeps. */
export function widgetDisplay(el: HTMLElement): string {
  const own = el instanceof HTMLInputElement ? el.value : '';
  const inner = el.querySelector('input:not([type="hidden"])') as HTMLInputElement | null;
  return collapse(`${own} ${inner?.value ?? ''} ${visibleText(el)}`);
}

function widgetIsFilled(el: HTMLElement): boolean {
  const placeholder = el.querySelector('[class*="placeholder" i]:not(input)');
  if (placeholder && isDisplayed(placeholder)) return false;
  const shown = widgetDisplay(el);
  return !!shown && !PLACEHOLDER_TEXT.test(shown);
}

/** Candidate for a non-semantic option: short clickable text with no control inside. */
function isOptionLike(el: HTMLElement): boolean {
  const role = el.getAttribute('role');
  const ariaOption = role === 'radio' || role === 'checkbox' || role === 'switch' || role === 'option';
  const text = el.textContent ?? '';
  if (text.length === 0 || text.length > 80) return false;
  if (el.querySelector('input, select, textarea')) return false;
  if (ariaOption) return true;
  if (!/^(DIV|SPAN|LI|A|LABEL|TD|P|BUTTON)$/.test(el.tagName)) return false;
  // A label for a native control is that control's text, not an option of its own.
  if (el instanceof HTMLLabelElement && el.control) return false;

  const clickable = role === 'button' || el.tagName === 'BUTTON' || el.hasAttribute('onclick')
    || getComputedStyle(el).cursor === 'pointer';
  if (!clickable) return false;

  // A wrapper of several options is the group, not an option.
  const withText = Array.from(el.children).filter((child) => collapse(child.textContent ?? ''));
  return withText.length < 2;
}

function clusterParent(el: Element): Element | null {
  let parent = el.parentElement;
  while (parent && parent.childElementCount === 1) parent = parent.parentElement;
  return parent;
}

function signatureOf(el: Element): string {
  const classes = classOf(el).split(/\s+/).filter((name) => name && !STATE_CLASS.test(name)).sort();
  return `${el.tagName}|${el.getAttribute('role') ?? ''}|${classes.join('.')}`;
}

/** Fingerprint of an option's visual state, to detect that a click changed it. */
export function stateFingerprint(el: Element): string {
  const parts = [el, ...Array.from(el.querySelectorAll('*'))].map((node) =>
    [classOf(node), node.getAttribute('aria-checked'), node.getAttribute('aria-selected'), node.getAttribute('aria-pressed'), node.getAttribute('data-state'), node.getAttribute('data-checked')]
      .join('|')
  );
  return parts.join(';');
}

export function customOptionSelected(el: Element): boolean | null {
  for (const attr of ['aria-checked', 'aria-selected', 'aria-pressed']) {
    const value = el.getAttribute(attr);
    if (value !== null) return value === 'true';
  }
  const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
  return nodes.some((node) => classOf(node).split(/\s+/).some((name) => SELECTED_CLASS.test(name)))
    ? true
    : null;
}

export function scanPage(registry: RefRegistry, root: Document = document): FieldBinding[] {
  const controls: ScanItem[] = [];
  const widgets: ScanItem[] = [];
  const optionLike: ScanItem[] = [];
  let heading = '';

  const walk = (parent: ParentNode) => {
    for (const child of Array.from(parent.children)) {
      const el = child as HTMLElement;
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute(OVERLAY_ATTR)) continue;

      if (/^H[1-6]$/.test(el.tagName) && isRendered(el)) {
        heading = visibleText(el) || heading;
      }
      const editable = el.getAttribute('contenteditable');
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
        || el.getAttribute('role') === 'textbox' || editable === 'true' || editable === 'plaintext-only') {
        (isWidgetRoot(el) ? widgets : controls).push({ el, heading });
        continue;
      }
      if (isWidgetRoot(el)) {
        widgets.push({ el, heading });
        continue;
      }
      if (isOptionLike(el)) {
        optionLike.push({ el, heading });
        continue;
      }
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  };
  walk(root);

  const fields: Array<{ order: Element; binding: FieldBinding }> = [];
  const add = (order: Element, binding: FieldBinding) => fields.push({ order, binding });

  /* ---------------- Text-like controls and <select> ---------------- */

  const groups = new Map<object, { members: HTMLInputElement[]; heading: string }>();

  for (const { el, heading: section } of controls) {
    if (el instanceof HTMLInputElement) {
      if (NON_FIELD_INPUTS.has(el.type) || el.disabled) continue;

      if (el.type === 'radio' || el.type === 'checkbox') {
        const scope = el.form ?? el.getRootNode();
        const name = el.name;
        const container = name ? null : composedClosest(el, 'fieldset, [role="radiogroup"], [role="group"]');
        const key = name
          ? registry.groupKey(scope, `${el.type}:${name}`)
          : container
            ? registry.groupKey(container, el.type)
            : el;
        const group = groups.get(key) ?? { members: [], heading: section };
        group.members.push(el);
        groups.set(key, group);
        continue;
      }
    }

    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) continue;
    // File inputs are routinely hidden behind a styled button.
    const isFile = el instanceof HTMLInputElement && el.type === 'file';
    if (!isFile && (!isDisplayed(el) || isUnreachable(el))) continue;
    if (isSiteSearch(el)) continue;

    const { label, hint } = nameOf(el);
    if (!label) continue;
    const name = el.getAttribute('name') ?? '';
    const blocked = classifyField({
      type: (el as HTMLInputElement).type,
      autocomplete: el.getAttribute('autocomplete') ?? '',
      name,
      id: el.id,
      label,
      placeholder: el.getAttribute('placeholder') ?? '',
    }) ?? undefined;

    const required = (el as HTMLInputElement).required === true
      || el.getAttribute('aria-required') === 'true' || requiredMark(label);
    const base = {
      id: registry.idFor(el, 'f'),
      label: cleanLabel(label),
      required,
      ...(hint ? { hint } : {}),
      ...(sectionOf(el, section) ? { section: sectionOf(el, section) } : {}),
      ...(blocked ? { blocked } : {}),
    };

    if (el instanceof HTMLSelectElement) {
      const options: OptionBinding[] = Array.from(el.options)
        .filter((option) => !option.disabled && (option.value !== '' || !!collapse(option.text)))
        .filter((option) => !(option.value === '' && PLACEHOLDER_TEXT.test(option.text)))
        .map((option) => ({
          id: registry.idFor(option, 'o'),
          label: collapse(option.text),
          input: option,
          face: el,
        }));
      const chosen = el.selectedOptions[0];
      const filled = !!chosen && chosen.value !== '' && !(el.selectedIndex === 0 && !el.multiple);
      add(el, {
        el,
        options,
        view: {
          ...base,
          kind: 'select',
          multiple: el.multiple || undefined,
          filled,
          options: options.map((option) => ({
            id: option.id,
            label: option.label,
            selected: (option.input as HTMLOptionElement).selected,
          })),
        },
      });
      continue;
    }

    const editable = !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement);
    const value = editable ? visibleText(el) : (el as HTMLInputElement).value;
    const inputType = el instanceof HTMLTextAreaElement
      ? 'multiline'
      : editable
        ? 'richtext'
        : (el as HTMLInputElement).type !== 'text' ? (el as HTMLInputElement).type : undefined;
    const maxLength = (el as HTMLInputElement).maxLength;
    add(el, {
      el,
      view: {
        ...base,
        kind: 'text',
        filled: !!value.trim(),
        ...(inputType ? { inputType } : {}),
        ...(maxLength > 0 ? { maxLength } : {}),
      },
    });
  }

  /* ---------------- Native radio and checkbox groups ---------------- */

  for (const [key, { members, heading: section }] of groups) {
    const usable = members
      .map((input) => ({ input, face: faceOf(input) }))
      .filter((member): member is { input: HTMLInputElement; face: HTMLElement } => !!member.face);
    if (usable.length === 0) continue;

    const inputs = usable.map((member) => member.input);
    const options: OptionBinding[] = usable.map(({ input, face }) => ({
      id: registry.idFor(input, 'o'),
      label: optionLabel(input),
      input,
      face,
    }));

    const kind = inputs[0].type === 'radio' ? 'radio' : 'checkbox';
    const single = kind === 'checkbox' && options.length === 1;
    const name = groupName(inputs);
    const rawLabel = single ? options[0].label || name.label : name.label || options[0].label;
    if (!rawLabel) continue;

    const allText = [rawLabel, ...options.map((option) => option.label)].join(' ');
    const blocked = isConsentText(allText) ? ('consent' as const) : undefined;
    const sectionText = sectionOf(inputs[0], section);

    add(inputs[0], {
      el: inputs[0],
      options,
      view: {
        id: registry.idFor(key, 'f'),
        kind,
        label: cleanLabel(rawLabel),
        required: name.required,
        multiple: kind === 'checkbox' || undefined,
        filled: inputs.some((input) => input.checked),
        ...(sectionText ? { section: sectionText } : {}),
        ...(blocked ? { blocked } : {}),
        options: options.map((option): OptionView => ({
          id: option.id,
          label: option.label,
          selected: (option.input as HTMLInputElement).checked,
        })),
      },
    });
  }

  /* ---------------- Custom widgets ---------------- */

  for (const { el, heading: section } of widgets) {
    if (!isDisplayed(el) || (el as HTMLInputElement).disabled) continue;
    if (composedClosest(el, `[${OVERLAY_ATTR}]`)) continue;

    const explicit = explicitName(el);
    // A trigger's own text is its value or placeholder, never its question.
    const context = explicit || precedingText(el);
    const placeholder = collapse(el.getAttribute('placeholder') ?? el.querySelector('input')?.getAttribute('placeholder') ?? '');
    const label = context || placeholder || humanize(el.getAttribute('name') ?? el.id ?? '');
    if (!label) continue;

    const blocked = classifyField({
      autocomplete: el.getAttribute('autocomplete') ?? '',
      name: el.getAttribute('name') ?? '',
      id: el.id,
      label,
    }) ?? undefined;
    const sectionText = sectionOf(el, section);
    const hint = placeholder && placeholder !== label ? placeholder : undefined;

    add(el, {
      el,
      view: {
        id: registry.idFor(el, 'f'),
        kind: 'widget',
        widget: widgetHint(el, label),
        label: cleanLabel(label),
        required: el.getAttribute('aria-required') === 'true' || requiredMark(label),
        filled: widgetIsFilled(el),
        ...(hint ? { hint } : {}),
        ...(sectionText ? { section: sectionText } : {}),
        ...(blocked ? { blocked } : {}),
      },
    });
  }

  /* ---------------- Non-semantic option groups ---------------- */

  const clusters = new Map<Element, Map<string, ScanItem[]>>();
  for (const item of optionLike) {
    if (!isDisplayed(item.el) || composedClosest(item.el, NOT_FORM_REGIONS)) continue;
    const parent = clusterParent(item.el);
    if (!parent) continue;
    const bySignature = clusters.get(parent) ?? new Map<string, ScanItem[]>();
    const signature = signatureOf(item.el);
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), item]);
    clusters.set(parent, bySignature);
  }

  for (const [parent, bySignature] of clusters) {
    for (const items of bySignature.values()) {
      if (items.length < 2 || items.length > 40) continue;
      const members = items.map((item) => item.el);

      const allowed = members.filter((member) => !forbiddenClick({
        tag: member.tagName,
        type: (member as HTMLButtonElement).type,
        role: member.getAttribute('role') ?? undefined,
        text: visibleText(member),
        href: member.getAttribute('href') ?? undefined,
        implicitSubmit: member instanceof HTMLButtonElement && !member.getAttribute('type') && !!member.form,
      }));
      if (allowed.length < 2) continue;

      const name = groupName(allowed);
      if (!name.label) continue;

      const role = allowed[0].getAttribute('role');
      const multiple = role === 'checkbox' || role === 'switch'
        || /check|multi/i.test(`${classOf(allowed[0])} ${classOf(parent)}`);
      const options: OptionBinding[] = allowed.map((member) => ({
        id: registry.idFor(member, 'o'),
        label: visibleText(member),
        face: member,
        baseline: stateFingerprint(member),
      }));
      const sectionText = items[0].heading;

      add(allowed[0], {
        el: allowed[0],
        options,
        view: {
          id: registry.idFor(parent, 'f'),
          kind: multiple ? 'checkbox' : 'radio',
          label: cleanLabel(name.label),
          required: name.required,
          multiple: multiple || undefined,
          filled: allowed.some((member) => customOptionSelected(member) === true),
          ...(sectionText ? { section: sectionText } : {}),
          options: options.map((option): OptionView => ({
            id: option.id,
            label: option.label,
            selected: customOptionSelected(option.face) === true,
          })),
        },
      });
    }
  }

  // Answer in the order the user reads the form.
  fields.sort((a, b) => {
    const position = a.order.compareDocumentPosition(b.order);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return fields.map((field) => field.binding);
}
