/**
 * Value comparison and coercion used to resolve answers and verify writes.
 *
 * Matching is exact-first and never picks by bare substring: with options
 * ["同意", "不同意"], the answer "不同意" must not land on "同意".
 */

export function normalizeText(text: string): string {
  const folded = text.normalize('NFKC').toLowerCase();
  const stripped = folded.replace(/[\s\p{P}\p{S}]+/gu, '');
  return stripped || folded.trim();
}

export function sameText(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

/**
 * Index of the option an answer refers to, or -1.
 * Exact normalized match wins; otherwise containment counts only if unique.
 */
export function findOptionIndex(labels: readonly string[], answer: string): number {
  const target = normalizeText(answer);
  if (!target) return -1;
  const normalized = labels.map(normalizeText);

  const exact = normalized.indexOf(target);
  if (exact !== -1) return exact;

  const containing = normalized.flatMap((label, index) =>
    label && (label.includes(target) || target.includes(label)) ? [index] : []
  );
  return containing.length === 1 ? containing[0] : -1;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

export interface LooseDate {
  year: number;
  month: number;
  day: number;
}

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

function monthFromName(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function validDate(year: number, month: number, day: number): LooseDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1000) return null;
  return { year, month, day };
}

/** Parses the date formats forms and calendars commonly display. */
export function parseLooseDate(text: string): LooseDate | null {
  const s = text.normalize('NFKC').trim();
  let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);

  // Ambiguous numeric dates read month-first, the common US display format.
  m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (m) {
    const [first, second, year] = [+m[1], +m[2], +m[3]];
    return first > 12 ? validDate(year, second, first) : validDate(year, first, second);
  }

  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m && monthFromName(m[1])) return validDate(+m[3], monthFromName(m[1]), +m[2]);

  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m && monthFromName(m[2])) return validDate(+m[3], monthFromName(m[2]), +m[1]);

  return null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function isoDate({ year, month, day }: LooseDate): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/* ------------------------------------------------------------------ */
/* Coercion and verification                                           */
/* ------------------------------------------------------------------ */

/** Rewrites an answer into the wire format a typed input demands. */
export function coerceForInput(inputType: string | undefined, value: string): string {
  const text = value.trim();
  switch (inputType) {
    case 'date': {
      const date = parseLooseDate(text);
      return date ? isoDate(date) : text;
    }
    case 'month': {
      const date = parseLooseDate(text);
      if (date) return `${pad(date.year, 4)}-${pad(date.month)}`;
      const m = text.normalize('NFKC').match(/(\d{4})\s*[-/.年]\s*(\d{1,2})/);
      return m ? `${m[1]}-${pad(+m[2])}` : text;
    }
    case 'time': {
      const m = text.normalize('NFKC').match(/(\d{1,2})\s*[:：时]\s*(\d{2})/);
      return m ? `${pad(+m[1])}:${m[2]}` : text;
    }
    case 'number':
    case 'range': {
      const m = text.normalize('NFKC').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m ? m[0] : text;
    }
    default:
      return text;
  }
}

/** Did a text control end up holding what we wrote, allowing for masks? */
export function textMatches(expected: string, actual: string, inputType?: string): boolean {
  if (sameText(expected, actual)) return true;
  if (!actual.trim()) return false;

  const digits = (s: string) => s.replace(/\D/g, '');
  if (inputType === 'tel' || inputType === 'number' || inputType === 'range') {
    const [a, b] = [digits(expected), digits(actual)];
    if (a && a === b) return true;
    return inputType === 'number' && Number(expected) === Number(actual);
  }

  const [dateA, dateB] = [parseLooseDate(expected), parseLooseDate(actual)];
  return !!dateA && !!dateB && isoDate(dateA) === isoDate(dateB);
}

/**
 * Does a widget's visible text show its target?
 * A cascader shows the path's leaf at minimum; other widgets show every value.
 */
export function displayMatches(
  target: readonly string[],
  display: string,
  widget?: string
): boolean {
  const shown = normalizeText(display);
  if (!shown) return false;

  if (widget === 'datepicker') {
    const [want, got] = [parseLooseDate(target[0] ?? ''), parseLooseDate(display)];
    if (want && got) return isoDate(want) === isoDate(got);
  }

  const required = widget === 'cascader' ? target.slice(-1) : target;
  return required.every((value) => {
    const wanted = normalizeText(value);
    return !!wanted && (shown.includes(wanted) || (shown.length >= 2 && wanted.includes(shown)));
  });
}
