/**
 * Safety policy: what the harness refuses to touch.
 *
 * Enforced in code at two points, so that it holds even if the model is
 * confused or prompt-injected by page content:
 *  - the snapshot tags blocked fields, and they are never offered to the model;
 *  - the page driver refuses forbidden writes and clicks at execution time.
 */
import type { BlockReason } from '../shared/types.ts';

export interface FieldTraits {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
}

const PASSWORD = /\bpass(word|code|phrase)\b|\bpwd\b|密码|口令/i;
const PAYMENT =
  /\b(cc|card)[-_ ]?(num|number|no)\b|\bcvv2?\b|\bcvc\b|\bcsc\b|credit[-_ ]?card|debit[-_ ]?card|\biban\b|银行卡|信用卡|储蓄卡|卡号|安全码/i;
const OTP = /\botp\b|one[-_ ]?time|verification[-_ ]?code|\b2fa\b|验证码|校验码|动态码/i;
const CAPTCHA = /captcha|人机验证/i;
const CONSENT =
  /(i\s+(agree|accept|consent)|agree\s+to|accept\s+the|terms\s+(of|and)|privacy\s+policy|同意.{0,12}(协议|条款|政策|声明)|我已(阅读|同意)|隐私(政策|条款)|服务条款)/i;

/** Returns why a field must not be filled, or null if it may be. */
export function classifyField(traits: FieldTraits): BlockReason | null {
  const type = (traits.type ?? '').toLowerCase();
  const autocomplete = (traits.autocomplete ?? '').toLowerCase();
  // \b sees no boundary inside user_pwd or smsOtp, so split machine names first.
  const identity = [traits.name, traits.id, traits.label, traits.placeholder]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');

  if (type === 'file') return 'file';
  if (type === 'password' || /(current|new)-password/.test(autocomplete)) return 'password';
  if (/\bcc-/.test(autocomplete)) return 'payment';
  if (autocomplete.includes('one-time-code')) return 'otp';
  if (CAPTCHA.test(identity)) return 'captcha';
  if (OTP.test(identity)) return 'otp';
  if (PAYMENT.test(identity)) return 'payment';
  if (PASSWORD.test(identity)) return 'password';
  return null;
}

/** Consent boxes record the user's legal agreement; only the user may tick them. */
export function isConsentText(text: string): boolean {
  return CONSENT.test(text);
}

export interface ClickTraits {
  tag: string;
  type?: string;
  role?: string;
  text?: string;
  href?: string;
  /** The element is a <button> without an explicit type inside a <form>. */
  implicitSubmit?: boolean;
}

/**
 * Text that marks a button as committing the form rather than editing it.
 * Chinese has no word boundaries for \b to match, so it matches as a prefix.
 */
const COMMITTING_EN =
  /^(submit|send|pay|purchase|buy|checkout|check out|place order|delete|remove|sign up|sign in|log in|login|register|next|continue|finish)\b/i;
const COMMITTING_ZH =
  /^(提交|发送|支付|付款|立即支付|购买|立即购买|下单|结算|删除|注销|登录|登入|注册|下一步|下一页|继续|完成)/;

/** Returns why an element must not be clicked, or null if it may be. */
export function forbiddenClick(traits: ClickTraits): string | null {
  const tag = traits.tag.toUpperCase();
  const type = (traits.type ?? '').toLowerCase();

  if (traits.implicitSubmit) return 'submit-button';
  if ((tag === 'INPUT' || tag === 'BUTTON') && /^(submit|reset|image)$/.test(type)) {
    return 'submit-button';
  }

  if (tag === 'A' && traits.href) {
    const href = traits.href.trim().toLowerCase();
    if (href && href !== '#' && !href.startsWith('javascript:')) return 'navigation-link';
  }

  const buttonLike = tag === 'BUTTON' || tag === 'A' || traits.role === 'button'
    || (tag === 'INPUT' && type === 'button');
  const text = (traits.text ?? '').trim();
  if (buttonLike && text.length <= 24) {
    // "Next month" navigates a calendar; only a bare "Next" advances a form.
    if (/^(next|continue)\s+\S/i.test(text)) return null;
    if (COMMITTING_EN.test(text) || COMMITTING_ZH.test(text)) return 'committing-action';
  }
  return null;
}
