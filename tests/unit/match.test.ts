import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coerceForInput,
  displayMatches,
  findOptionIndex,
  isoDate,
  normalizeText,
  parseLooseDate,
  textMatches,
} from '../../src/harness/match.ts';

describe('findOptionIndex', () => {
  it('does not confuse an option with its negation', () => {
    // v2 used bare substring matching, which selected 同意 for the answer 不同意.
    assert.equal(findOptionIndex(['同意', '不同意'], '不同意'), 1);
    assert.equal(findOptionIndex(['同意', '不同意'], '同意'), 0);
    assert.equal(findOptionIndex(['Agree', 'Disagree'], 'Disagree'), 1);
    assert.equal(findOptionIndex(['Agree', 'Disagree'], 'agree'), 0);
  });

  it('accepts unique containment but refuses ambiguity', () => {
    assert.equal(findOptionIndex(['Bachelor of Science', 'Master of Science'], 'Bachelor'), 0);
    assert.equal(findOptionIndex(['Bachelor of Science', 'Master of Science'], 'Science'), -1);
  });

  it('ignores width, case and punctuation differences', () => {
    assert.equal(findOptionIndex(['Ｙｅｓ', 'No'], 'yes'), 0);
    assert.equal(findOptionIndex(['上海市', '北京市'], '上海'), 0);
  });

  it('returns -1 for an empty answer', () => {
    assert.equal(findOptionIndex(['A'], '   '), -1);
  });
});

describe('normalizeText', () => {
  it('keeps text made only of punctuation comparable', () => {
    assert.equal(normalizeText(' -- '), '--');
  });
});

describe('parseLooseDate', () => {
  const cases: Array<[string, string]> = [
    ['2024-03-15', '2024-03-15'],
    ['2024/3/5', '2024-03-05'],
    ['2024年3月5日', '2024-03-05'],
    ['03/15/2024', '2024-03-15'],
    ['15/03/2024', '2024-03-15'],
    ['March 15, 2024', '2024-03-15'],
    ['15 Mar 2024', '2024-03-15'],
    ['Sept. 2nd, 1995', '1995-09-02'],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${input}`, () => {
      const date = parseLooseDate(input);
      assert.ok(date);
      assert.equal(isoDate(date), expected);
    });
  }

  it('rejects text with no date', () => {
    assert.equal(parseLooseDate('next Tuesday'), null);
    assert.equal(parseLooseDate('2024-13-40'), null);
  });
});

describe('coerceForInput', () => {
  it('converts values to the format typed inputs require', () => {
    assert.equal(coerceForInput('date', '1995年9月2日'), '1995-09-02');
    assert.equal(coerceForInput('month', '2024年3月'), '2024-03');
    assert.equal(coerceForInput('time', '9:30'), '09:30');
    assert.equal(coerceForInput('number', '25岁'), '25');
    assert.equal(coerceForInput('number', '1,200.50'), '1200.50');
    assert.equal(coerceForInput('email', ' a@b.co '), 'a@b.co');
  });
});

describe('textMatches', () => {
  it('sees through input masks on phone numbers', () => {
    assert.ok(textMatches('13800138000', '138-0013-8000', 'tel'));
    assert.ok(!textMatches('13800138000', '138-0013-8001', 'tel'));
  });

  it('treats numerically equal values as equal', () => {
    assert.ok(textMatches('25.0', '25', 'number'));
  });

  it('compares dates across formats', () => {
    assert.ok(textMatches('2024-03-15', '03/15/2024'));
  });

  it('fails on an empty read-back', () => {
    assert.ok(!textMatches('anything', ''));
  });
});

describe('displayMatches', () => {
  it('checks every value of a multi-value widget', () => {
    assert.ok(displayMatches(['Red', 'Blue'], 'Red, Blue'));
    assert.ok(!displayMatches(['Red', 'Blue'], 'Red'));
  });

  it('only needs the leaf of a cascader path', () => {
    assert.ok(displayMatches(['广东省', '深圳市', '南山区'], '南山区', 'cascader'));
    assert.ok(!displayMatches(['广东省', '深圳市', '南山区'], '广东省', 'cascader'));
  });

  it('compares dates semantically in a datepicker', () => {
    assert.ok(displayMatches(['2024-03-15'], 'March 15, 2024', 'datepicker'));
    assert.ok(!displayMatches(['2024-03-15'], '2024-03-16', 'datepicker'));
  });

  it('accepts a display that abbreviates the target', () => {
    assert.ok(displayMatches(['上海市'], '上海'));
  });

  it('fails on an empty display', () => {
    assert.ok(!displayMatches(['x'], '  '));
  });
});
