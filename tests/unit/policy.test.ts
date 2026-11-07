import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyField, forbiddenClick, isConsentText } from '../../src/harness/policy.ts';

describe('classifyField', () => {
  const blocked: Array<[Parameters<typeof classifyField>[0], string]> = [
    [{ type: 'password' }, 'password'],
    [{ autocomplete: 'new-password' }, 'password'],
    [{ label: 'Confirm password' }, 'password'],
    [{ label: '登录密码' }, 'password'],
    [{ autocomplete: 'cc-number' }, 'payment'],
    [{ name: 'card_number' }, 'payment'],
    [{ label: 'CVV' }, 'payment'],
    [{ label: '银行卡号' }, 'payment'],
    [{ autocomplete: 'one-time-code' }, 'otp'],
    [{ label: '短信验证码' }, 'otp'],
    [{ label: 'Verification code' }, 'otp'],
    [{ name: 'g-recaptcha-response' }, 'captcha'],
    [{ type: 'file' }, 'file'],
    [{ name: 'user_pwd' }, 'password'],
    [{ name: 'userPassword' }, 'password'],
    [{ name: 'sms_otp' }, 'otp'],
    [{ id: 'cardNumber' }, 'payment'],
    [{ name: 'creditCard' }, 'payment'],
  ];
  for (const [traits, reason] of blocked) {
    it(`blocks ${JSON.stringify(traits)} as ${reason}`, () => {
      assert.equal(classifyField(traits), reason);
    });
  }

  const allowed = [
    { label: 'Full name' },
    { label: 'Email', type: 'email', autocomplete: 'email' },
    { label: '身份证号' },
    { name: 'postcode' },
    { label: 'Business card title' },
  ];
  for (const traits of allowed) {
    it(`allows ${JSON.stringify(traits)}`, () => {
      assert.equal(classifyField(traits), null);
    });
  }
});

describe('isConsentText', () => {
  it('recognises consent wording in both languages', () => {
    assert.ok(isConsentText('I agree to the Terms of Service'));
    assert.ok(isConsentText('我已阅读并同意隐私政策'));
    assert.ok(isConsentText('同意用户协议'));
  });

  it('ignores ordinary survey options', () => {
    assert.ok(!isConsentText('同意'));
    assert.ok(!isConsentText('Strongly agree'));
  });
});

describe('forbiddenClick', () => {
  it('blocks submit controls', () => {
    assert.ok(forbiddenClick({ tag: 'BUTTON', type: 'submit' }));
    assert.ok(forbiddenClick({ tag: 'INPUT', type: 'submit' }));
    assert.ok(forbiddenClick({ tag: 'BUTTON', implicitSubmit: true }));
    assert.ok(forbiddenClick({ tag: 'BUTTON', type: 'button', text: '提交' }));
    assert.ok(forbiddenClick({ tag: 'DIV', role: 'button', text: 'Pay now' }));
    assert.ok(forbiddenClick({ tag: 'A', href: '#', text: 'Next' }));
  });

  it('blocks links that navigate away', () => {
    assert.ok(forbiddenClick({ tag: 'A', href: 'https://evil.test/' }));
    assert.ok(forbiddenClick({ tag: 'A', href: '/account/delete' }));
  });

  it('allows the controls widgets are made of', () => {
    assert.equal(forbiddenClick({ tag: 'A', href: '#', text: '北京' }), null);
    assert.equal(forbiddenClick({ tag: 'A', href: 'javascript:void(0)', text: 'x' }), null);
    assert.equal(forbiddenClick({ tag: 'BUTTON', type: 'button', text: 'Next month' }), null);
    assert.equal(forbiddenClick({ tag: 'TD', text: '15' }), null);
    assert.equal(forbiddenClick({ tag: 'LI', role: 'option', text: 'Send by post' }), null);
  });
});
