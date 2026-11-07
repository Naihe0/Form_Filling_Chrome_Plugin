/**
 * Tolerant JSON extraction for model replies.
 *
 * Structured output makes this a fallback, but not every provider or model
 * honours a schema, so replies may arrive fenced, wrapped in prose, or with
 * unescaped quotes inside Chinese text.
 */

/** The outermost [...] or {...} in text, or null. */
function extractOuterJson(text: string): string | null {
  const array = text.indexOf('[');
  const object = text.indexOf('{');
  if (array < 0 && object < 0) return null;

  const useArray = array >= 0 && (object < 0 || array < object);
  const start = useArray ? array : object;
  const end = text.lastIndexOf(useArray ? ']' : '}');
  return end > start ? text.slice(start, end + 1) : null;
}

/** Escapes stray quotes and raw control characters inside string values. */
export function repairJson(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString && ch === '\\' && i + 1 < text.length) {
      out += ch + text[++i];
    } else if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
        continue;
      }
      // A real closing quote is followed by a structural character or the end.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j >= text.length || /[,\]}:]/.test(text[j])) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
    } else if (inString && ch === '\n') {
      out += '\\n';
    } else if (inString && ch === '\r') {
      out += '\\r';
    } else if (inString && ch === '\t') {
      out += '\\t';
    } else {
      out += ch;
    }
  }
  return out;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Parses a model reply into a JSON value, or throws if nothing is salvageable. */
export function parseModelJson(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : reply).trim();
  const outer = extractOuterJson(text);

  const attempts = [text, outer, outer && repairJson(outer), repairJson(text)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    const parsed = tryParse(attempt);
    if (parsed.ok) return parsed.value;
  }
  throw new SyntaxError(`No JSON found in reply: ${reply.slice(0, 200)}`);
}
