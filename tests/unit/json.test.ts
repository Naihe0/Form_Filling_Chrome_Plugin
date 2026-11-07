import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseModelJson } from '../../src/harness/json.ts';

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  });

  it('unwraps code fences', () => {
    assert.deepEqual(parseModelJson('```json\n[1,2]\n```'), [1, 2]);
    assert.deepEqual(parseModelJson('Here you go:\n```\n{"a":1}\n```\nDone.'), { a: 1 });
  });

  it('extracts JSON surrounded by prose', () => {
    assert.deepEqual(parseModelJson('Sure! {"a":{"b":2}} Hope that helps.'), { a: { b: 2 } });
  });

  it('repairs unescaped quotes inside Chinese text', () => {
    const reply = '{"answer":"主导了"跨境支付"功能"}';
    assert.deepEqual(parseModelJson(reply), { answer: '主导了"跨境支付"功能' });
  });

  it('repairs raw newlines inside strings', () => {
    assert.deepEqual(parseModelJson('{"a":"line one\nline two"}'), { a: 'line one\nline two' });
  });

  it('keeps existing escapes intact', () => {
    assert.deepEqual(parseModelJson('{"a":"say \\"hi\\""}'), { a: 'say "hi"' });
  });

  it('throws when nothing is salvageable', () => {
    assert.throws(() => parseModelJson('I cannot help with that.'), SyntaxError);
  });
});
