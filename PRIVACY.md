# Privacy Policy

**Last updated: November 7, 2026**

[中文版本](#隐私政策)

AI Form Filler has no server. The developer receives no data from it. It runs in your browser and talks only to the LLM provider you choose, with your own API key.

## What is stored, and where

| Data | Where | Notes |
|---|---|---|
| Your profile | `chrome.storage.local`, and `chrome.storage.sync` if it fits (8 KB) | Sync is run by Google and follows your Chrome sync settings. |
| API keys | `chrome.storage.local` only | Never synced. Readable only by the extension's own pages, not by scripts in web pages. |
| Settings | `chrome.storage.local` | Language, provider, model, toggles. |
| Run reports | `chrome.storage.session` | Field names and statuses, no values. Held in memory, and cleared when you leave the page. |

## What is sent to your LLM provider

Only when you press **Start Filling**, or type a Quick Query trigger.

**When filling a form:**
- Your profile.
- For each fillable field on the page: its label, hints, options, and type.
- The site's hostname and the page title.
- Today's date.
- For interactive widgets such as custom dropdowns: the text of the widget and of the popup it opens, and what it currently shows.

**When using Quick Query:**
- Your profile, the text you typed in that field, the field's label, and the page title.

**Never sent:**
- The page's HTML.
- Hidden inputs, such as security tokens.
- Password, payment, one-time code and CAPTCHA fields, which are not even named to the model.
- Anything you have typed into other fields, unless it is part of a widget being filled.

Your provider's own privacy policy governs what it does with this data. All provider calls use HTTPS.

## What is not done

- No analytics, telemetry or tracking.
- No selling or sharing of data with anyone other than the provider you chose.
- No remote code or fonts.
- Forms are never submitted for you.

## Permissions

The extension requests access to all sites so that it can fill forms wherever you ask, including inside embedded frames. It does not run on a page until you press **Start Filling**, or unless you have turned on Quick Query, which runs on every page and sends nothing until you type its trigger.

## Your control

- View, edit or delete your profile and keys in the popup at any time.
- Uninstalling removes all local data. Data in `chrome.storage.sync` is managed by your Chrome sync settings.

## Upgrading from v2

v2 stored API keys in `chrome.storage.sync`. v3 removes them from there the first time it runs.

---

# 隐私政策

**最后更新：2026 年 11 月 7 日**

AI 智能填表助手没有服务器，开发者不会收到任何数据。它运行在你的浏览器中，只与你选择的 LLM 服务商通信，使用的是你自己的 API 密钥。

## 存储的内容与位置

| 数据 | 位置 | 说明 |
|---|---|---|
| 用户画像 | `chrome.storage.local`；不超过 8 KB 时同时存入 `chrome.storage.sync` | 同步由 Google 提供，遵循你的 Chrome 同步设置。 |
| API 密钥 | 仅 `chrome.storage.local` | 从不同步。只有扩展自身页面可读取，网页中的脚本无法读取。 |
| 设置 | `chrome.storage.local` | 语言、服务商、模型、开关。 |
| 运行报告 | `chrome.storage.session` | 字段名称和状态，不含填写内容。仅保存在内存中，离开页面即清除。 |

## 发送给 LLM 服务商的内容

仅在你点击**开始填充**，或输入快捷问询触发符时发送。

**填写表单时：**
- 你的用户画像。
- 页面上每个可填字段的标签、提示、选项和类型。
- 网站域名和页面标题。
- 当天日期。
- 对于自定义下拉框等交互组件：组件及其弹出层的文字，以及组件当前显示的内容。

**使用快捷问询时：**
- 你的用户画像、你在该输入框中输入的文字、字段标签和页面标题。

**绝不发送：**
- 页面 HTML。
- 隐藏输入框，例如安全令牌。
- 密码、支付信息、一次性验证码和人机验证字段，模型甚至不知道这些字段存在。
- 你在其他字段中输入的内容，除非它属于正在填写的组件。

服务商如何处理这些数据，由其自身的隐私政策决定。所有服务商调用均使用 HTTPS。

## 我们不做的事

- 没有分析、遥测或跟踪。
- 不向你选择的服务商以外的任何一方出售或共享数据。
- 不加载远程代码或字体。
- 从不替你提交表单。

## 权限

扩展请求访问所有网站的权限，以便在你需要的任何地方填写表单，包括内嵌框架中的表单。在你点击**开始填充**之前，它不会在页面上运行；除非你开启了快捷问询，该功能会在每个页面运行，但在你输入触发符之前不会发送任何内容。

## 你的控制权

- 可随时在弹窗中查看、编辑或删除画像和密钥。
- 卸载扩展会清除所有本地数据。`chrome.storage.sync` 中的数据由你的 Chrome 同步设置管理。

## 从 v2 升级

v2 曾将 API 密钥存入 `chrome.storage.sync`。v3 首次运行时会将其从中删除。
