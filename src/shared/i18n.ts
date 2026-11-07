/**
 * Runtime i18n (EN / 中文), switchable without reloading the extension.
 * zh_CN is typed against en, so a missing translation fails the type check.
 */
import type { Language } from './settings.ts';

const en = {
  extensionName: 'AI Form Filler',

  tabProfile: 'Profile',
  tabFill: 'Fill',

  profilePlaceholder:
    'Describe yourself in plain language: name, contact details, education, work history, preferences...',
  profileHelp: 'Sent to your chosen LLM provider when filling. Do not include passwords or card numbers.',
  saveBtn: 'Save',
  profileSaved: 'Profile saved.',
  profileSavedLocal: 'Saved on this device. It is too large to sync across devices.',
  profileEmpty: 'The profile is empty.',

  serviceProvider: 'Service Provider',
  modelId: 'Model ID',
  modelIdPlaceholder: 'Default: {model}',
  apiKey: 'API Key',
  apiKeyPlaceholder: 'Enter your API key',

  overwriteExisting: 'Overwrite existing values',
  quickQuery: 'Quick Query',
  quickQueryHint: 'End your text with ``` or ··· in any field to continue it with AI.',

  startFilling: 'Start Filling',
  stopFilling: 'Stop',
  fillAgain: 'Back',

  statusNeedProfile: 'Add your profile in the Profile tab first.',
  statusNeedKey: 'Enter your API key first.',
  statusRestrictedPage: 'Chrome does not allow extensions on this page.',
  statusNoTab: 'No active tab found.',
  statusStartFailed: 'Could not start: {message}',
  statusQuickQuerySetup: 'Set a profile and API key before enabling Quick Query.',

  runProgress: 'Filling {done} of {total}',
  runPlanning: 'Reading the form...',

  reportTitleCompleted: 'Done. Review before submitting.',
  reportTitleStopped: 'Stopped.',
  reportTitleBudget: 'Stopped: the run limit was reached.',
  reportTitleFailed: 'The run failed.',
  reportNoFields: 'No fillable fields found on this page.',
  reportFilled: '{count} filled',
  reportSkipped: '{count} not in profile',
  reportAttention: 'Needs your attention',
  reportUsage: 'Model calls: {calls} · Tokens: {tokens} · {seconds}s',

  panelStarting: 'Reading the form...',
  panelPlanning: 'Working out {count} answers',
  panelFilling: 'Filling ({done}/{total}): {label}',
  panelDone: 'Filled {filled}. {attention} need attention. Review before submitting.',
  panelAllGood: 'Filled {filled}. Review before submitting.',
  panelNothing: 'No fillable fields found.',
  panelStopped: 'Stopped.',
  panelFailed: 'Failed: {message}',
  panelClose: 'Close',

  queryGenerating: 'Generating...',
  queryFailed: 'Quick Query failed: {message}',

  detailNoProfileData: 'not in your profile',
  detailPassword: 'password; enter it yourself',
  detailPayment: 'payment details; enter them yourself',
  detailOtp: 'verification code; enter it yourself',
  detailCaptcha: 'CAPTCHA; complete it yourself',
  detailConsent: 'consent; tick it yourself if you agree',
  detailFile: 'file upload; choose the file yourself',
  detailVerifyFailed: 'the page did not accept the value',
  detailUnconfirmed: 'filled, but please check it',
  detailFailed: 'could not fill',

  errorAuth: 'The provider rejected the API key.',
  errorModel: 'The provider does not offer this model: {message}',
  errorQuota: 'The provider says the quota is used up.',
  errorRateLimited: 'The provider is rate limiting requests. Try again shortly.',
  errorNetwork: 'Could not reach the provider.',
  errorTimeout: 'The model did not answer in time.',
  errorNotConfigured: 'No API key is configured.',
} as const;

export type MessageKey = keyof typeof en;

const zh_CN: Record<MessageKey, string> = {
  extensionName: 'AI 智能填表助手',

  tabProfile: '画像',
  tabFill: '填充',

  profilePlaceholder: '用自然语言介绍你自己：姓名、联系方式、教育背景、工作经历、偏好等……',
  profileHelp: '填表时会发送给你选择的 LLM 服务商。请勿填写密码或银行卡号。',
  saveBtn: '保存',
  profileSaved: '画像已保存。',
  profileSavedLocal: '已保存到本机。内容过大，无法跨设备同步。',
  profileEmpty: '画像内容为空。',

  serviceProvider: '服务商',
  modelId: '模型 ID',
  modelIdPlaceholder: '默认：{model}',
  apiKey: 'API 密钥',
  apiKeyPlaceholder: '输入你的 API 密钥',

  overwriteExisting: '覆盖已有内容',
  quickQuery: '快捷问询',
  quickQueryHint: '在任意输入框中以 ``` 或 ··· 结尾，由 AI 续写内容。',

  startFilling: '开始填充',
  stopFilling: '停止',
  fillAgain: '返回',

  statusNeedProfile: '请先在画像页填写你的画像。',
  statusNeedKey: '请先输入 API 密钥。',
  statusRestrictedPage: 'Chrome 不允许扩展在此页面上运行。',
  statusNoTab: '未找到当前标签页。',
  statusStartFailed: '无法启动：{message}',
  statusQuickQuerySetup: '启用快捷问询前，请先设置画像和 API 密钥。',

  runProgress: '正在填充 {done} / {total}',
  runPlanning: '正在读取表单……',

  reportTitleCompleted: '已完成。提交前请检查。',
  reportTitleStopped: '已停止。',
  reportTitleBudget: '已停止：达到运行上限。',
  reportTitleFailed: '运行失败。',
  reportNoFields: '此页面没有可填充的字段。',
  reportFilled: '已填 {count} 项',
  reportSkipped: '{count} 项画像中没有',
  reportAttention: '需要你处理',
  reportUsage: '调用模型 {calls} 次 · {tokens} token · {seconds} 秒',

  panelStarting: '正在读取表单……',
  panelPlanning: '正在分析 {count} 项答案',
  panelFilling: '正在填充（{done}/{total}）：{label}',
  panelDone: '已填 {filled} 项，{attention} 项需要处理。提交前请检查。',
  panelAllGood: '已填 {filled} 项。提交前请检查。',
  panelNothing: '未找到可填充的字段。',
  panelStopped: '已停止。',
  panelFailed: '失败：{message}',
  panelClose: '关闭',

  queryGenerating: '正在生成……',
  queryFailed: '快捷问询失败：{message}',

  detailNoProfileData: '画像中没有',
  detailPassword: '密码，请自行输入',
  detailPayment: '支付信息，请自行输入',
  detailOtp: '验证码，请自行输入',
  detailCaptcha: '人机验证，请自行完成',
  detailConsent: '同意条款，如同意请自行勾选',
  detailFile: '文件上传，请自行选择文件',
  detailVerifyFailed: '页面没有接受该值',
  detailUnconfirmed: '已填写，请核对',
  detailFailed: '未能填写',

  errorAuth: '服务商拒绝了该 API 密钥。',
  errorModel: '服务商不提供此模型：{message}',
  errorQuota: '服务商提示额度已用完。',
  errorRateLimited: '服务商正在限流，请稍后再试。',
  errorNetwork: '无法连接服务商。',
  errorTimeout: '模型未能及时响应。',
  errorNotConfigured: '尚未配置 API 密钥。',
};

const dictionaries: Record<Language, Record<MessageKey, string>> = { en, zh_CN };

let current: Language = 'en';

export function setLanguage(language: Language): void {
  current = language;
}

export function getLanguage(): Language {
  return current;
}

export function detectLanguage(browserLanguage: string): Language {
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh_CN' : 'en';
}

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  let text: string = dictionaries[current][key];
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

const DETAIL_MESSAGES: Record<string, MessageKey> = {
  'no-profile-data': 'detailNoProfileData',
  password: 'detailPassword',
  payment: 'detailPayment',
  otp: 'detailOtp',
  captcha: 'detailCaptcha',
  consent: 'detailConsent',
  file: 'detailFile',
  'verify-failed': 'detailVerifyFailed',
  reverted: 'detailVerifyFailed',
  'value-differs': 'detailUnconfirmed',
  'display-mismatch': 'detailUnconfirmed',
  'no-readable-state': 'detailUnconfirmed',
};

/** Human wording for an outcome's machine-readable detail. */
export function detailMessage(detail: string | undefined): string {
  return t(DETAIL_MESSAGES[detail ?? ''] ?? 'detailFailed');
}

const ERROR_MESSAGES: Record<string, MessageKey> = {
  auth: 'errorAuth',
  model_not_found: 'errorModel',
  quota: 'errorQuota',
  rate_limited: 'errorRateLimited',
  network: 'errorNetwork',
  timeout: 'errorTimeout',
  not_configured: 'errorNotConfigured',
};

/** Human wording for a run error, falling back to the provider's own message. */
export function errorMessage(error: { code: string; message: string }): string {
  const key = ERROR_MESSAGES[error.code];
  return key ? t(key, { message: error.message }) : error.message;
}
