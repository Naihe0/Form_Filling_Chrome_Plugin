import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  detailMessage,
  detectLanguage,
  errorMessage,
  setLanguage,
  t,
} from '../../src/shared/i18n.ts';

afterEach(() => setLanguage('en'));

describe('t', () => {
  it('interpolates parameters', () => {
    assert.equal(t('reportFilled', { count: 3 }), '3 filled');
    setLanguage('zh_CN');
    assert.equal(t('reportFilled', { count: 3 }), '已填 3 项');
  });
});

describe('detectLanguage', () => {
  it('maps browser locales', () => {
    assert.equal(detectLanguage('zh-CN'), 'zh_CN');
    assert.equal(detectLanguage('zh-TW'), 'zh_CN');
    assert.equal(detectLanguage('en-US'), 'en');
    assert.equal(detectLanguage('fr'), 'en');
  });
});

describe('messages for outcomes and errors', () => {
  it('words known details and falls back for unknown ones', () => {
    assert.equal(detailMessage('password'), t('detailPassword'));
    assert.equal(detailMessage('anything-else'), t('detailFailed'));
    assert.equal(detailMessage(undefined), t('detailFailed'));
  });

  it('words known errors and keeps provider text for unknown ones', () => {
    assert.equal(errorMessage({ code: 'auth', message: 'HTTP 401' }), t('errorAuth'));
    assert.equal(errorMessage({ code: 'server', message: 'HTTP 500: oops' }), 'HTTP 500: oops');
    assert.match(errorMessage({ code: 'model_not_found', message: 'use gemini-3.8-flash' }), /gemini-3\.8-flash/);
  });
});
