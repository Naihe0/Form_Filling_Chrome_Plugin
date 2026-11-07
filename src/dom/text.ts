/** Reading what a user can actually see: text and visibility in the flat tree. */

/** Also drops zero-width characters, which MUI renders to hold an empty select open. */
export function collapse(text: string): string {
  return text.replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
}

const TEXT_EXCLUDED = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'SVG', 'CANVAS',
]);

const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'CODE', 'EM', 'FONT', 'I', 'LABEL', 'MARK', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U',
]);

/** True unless CSS hides the element, including through an ancestor. */
export function isRendered(el: Element): boolean {
  return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true } as CheckVisibilityOptions);
}

/** Rendered and occupying space. */
export function isDisplayed(el: Element): boolean {
  if (!el.isConnected || !isRendered(el)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * A control rendered where no user can reach it is a honeypot or a leftover.
 * Bots fill these; a person never would. Radios and checkboxes are exempt,
 * since custom designs routinely hide them behind a styled proxy.
 */
export function isUnreachable(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 2 || rect.height <= 2) return true;
  if (rect.right + window.scrollX <= 0 || rect.bottom + window.scrollY <= 0) return true;
  if (getComputedStyle(el).opacity === '0') return true;
  if (el.tabIndex === -1 && el.getAttribute('aria-hidden') === 'true') return true;

  // Clipped away by an ancestor, such as `height: 0; overflow: hidden`. Scrolling
  // containers do not count, since a user can scroll to what they hide.
  for (let node = composedParent(el); node && node !== document.body; node = composedParent(node)) {
    const { overflowX, overflowY } = getComputedStyle(node);
    if (!/hidden|clip/.test(`${overflowX} ${overflowY}`)) continue;
    const clip = node.getBoundingClientRect();
    const overlaps = rect.left < clip.right && rect.right > clip.left
      && rect.top < clip.bottom && rect.bottom > clip.top;
    if (!overlaps) return true;
  }
  return false;
}

/** Visible text of an element, skipping form controls and their option lists. */
export function visibleText(el: Element, limit = 240): string {
  let out = '';
  const visit = (node: Node) => {
    if (out.length > limit) return;
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (TEXT_EXCLUDED.has(tag) || !isRendered(element)) return;

    for (const child of Array.from(element.childNodes)) visit(child);
    if (element.shadowRoot) {
      for (const child of Array.from(element.shadowRoot.childNodes)) visit(child);
    }
    if (!INLINE_TAGS.has(tag)) out += ' ';
  };
  visit(el);
  return collapse(out).slice(0, limit);
}

/** The parent element, crossing out of a shadow root when needed. */
export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** closest() that also searches through shadow boundaries. */
export function composedClosest(el: Element, selector: string): Element | null {
  for (let node: Element | null = el; node; node = composedParent(node)) {
    if (node.matches(selector)) return node;
  }
  return null;
}

const CONTROLS = 'input, select, textarea, button, [contenteditable="true"], [role="combobox"]';

/**
 * Text immediately before an element: `Name: <input>`, a preceding <td>, or a
 * <div> just above it. Stops at another control, whose text belongs to that
 * control, rather than mislabel this one.
 */
export function precedingText(el: Element, maxLevels = 5): string {
  let node: Node | null = el;

  for (let level = 0; node && level < maxLevels; level++) {
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === Node.TEXT_NODE) {
        const text = collapse(sibling.nodeValue ?? '');
        if (text) return text.slice(-200);
      } else if (sibling.nodeType === Node.ELEMENT_NODE) {
        const element = sibling as Element;
        if (!isRendered(element)) continue;
        if (element.matches(CONTROLS) || element.querySelector(CONTROLS)) return '';
        const text = visibleText(element);
        if (text) return text.slice(-200);
      }
    }
    const parent: Element | null = node instanceof Element ? composedParent(node) : null;
    if (!parent || parent === document.body) break;
    node = parent;
  }
  return '';
}

/** Text inside `container` that comes before `target`, e.g. a question above its options. */
export function textBefore(container: Element, target: Element): string {
  let out = '';
  const visit = (node: Node): boolean => {
    if (node === target) return true;
    if (node.nodeType === Node.TEXT_NODE) {
      out += ` ${node.nodeValue ?? ''}`;
      return false;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node as Element;
    if (TEXT_EXCLUDED.has(element.tagName.toUpperCase()) || !isRendered(element)) return false;
    for (const child of Array.from(element.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(container);
  return collapse(out).slice(-240);
}

/** The deepest element containing all of the given elements. */
export function commonAncestor(elements: Element[]): Element | null {
  if (elements.length === 0) return null;
  let ancestor: Element | null = elements[0];
  while (ancestor && !elements.every((element) => ancestor!.contains(element))) {
    ancestor = composedParent(ancestor);
  }
  return ancestor;
}
