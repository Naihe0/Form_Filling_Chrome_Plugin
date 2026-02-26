# AI Form Filler — Chrome Extension

An intelligent Chrome extension that uses Large Language Models (LLMs) to automatically analyse and fill web forms based on a user-defined profile.

> **Version 2.0** — Fully refactored with modular architecture, runtime EN/中文 switching, and multi-provider LLM support.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Multi-Provider LLM** | Switch between **OpenRouter**, **OpenAI**, **Gemini**, and **Qwen** — enter any model ID and API key per provider. |
| **Bilingual UI** | Toggle between English and Chinese at runtime; the entire popup and all in-page status messages update instantly. |
| **AI-Powered** | Uses LLMs to *understand* form semantics instead of relying on brittle CSS selectors or hard-coded rules. |
| **LLM Agent Loop** | For dynamic widgets (dropdowns, calendars, cascaders, map-like selectors), the extension runs an observe → ask LLM → execute → observe loop until done or limit reached. |
| **Quick Query** | In any text box, type three back-ticks (` ``` `) or middle-dots (`···`) to trigger an AI auto-completion based on your profile. |
| **Smart Correction** | When a field fill fails, the extension automatically asks the LLM to analyse the surrounding HTML and retry with a corrected selector. |
| **Ambiguity Resolution** | When a selector matches multiple elements, the extension uses text proximity to the question label to pick the right one. |
| **Visual Feedback** | A floating status bar on the page shows live progress, elapsed time, and per-field status (green = success, red = error). |
| **Profile Management** | Append, edit, and persist natural-language profile entries — no JSON required. |

---

## 🚀 Quick Start

### Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. After updating, click the **Refresh** button on the extension card to reload the manifest.

### Usage

#### 1. Set your Profile

Open the extension popup → **Profile** tab → type your personal information (in natural language) → click the upload icon to save.

#### 2. Configure a Provider

Open the popup → **Fill** tab:

| Field | Example |
|---|---|
| **Service Provider** | `OpenAI` |
| **Model ID** | `gpt-4.1` |
| **API Key** | `sk-...` |

Each provider's API key and model are saved independently — switching providers loads the previously saved config.

#### 3. Fill a Form

Navigate to a page with a form, open the popup, and click **Start Filling**. The extension will:

1. Extract all form fields via LLM analysis of the page HTML.
2. Match field values against your profile.
3. Fill each field with visual feedback and LLM-driven step-by-step interaction for dynamic components.
4. Auto-correct on failure using a second LLM call.

Click **Stop Filling** at any time to abort.

#### 4. Quick Query

With profile and API key configured, enable **Quick Query** in the Fill tab. Then, on any page, focus a text field, type some context, and end with ` ``` ` or `···`. The AI will auto-complete based on your profile.

---

## 🗂️ Project Structure

```
├── manifest.json              # Extension manifest (MV3)
├── background.js              # Service worker — proxies LLM API calls
├── lib/
│   ├── i18n.js                # Runtime i18n (EN / 中文)
│   ├── storage.js             # Unified chrome.storage abstraction
│   └── providers.js           # Provider registry (endpoints & defaults)
├── content/
│   ├── statusUI.js            # Floating status overlay
│   ├── interactionHandler.js  # LLM-driven interaction agent loop
│   ├── fieldExtractor.js      # LLM-based field extraction
│   ├── fieldProcessor.js      # Field filling, correction, ambiguity
│   └── main.js                # Orchestrator (FormFillerAgent + QuickQuery)
├── popup/
│   ├── popup.html             # Popup markup with i18n attributes
│   ├── popup.css              # Popup styles
│   └── popup.js               # Popup logic & event handling
├── _locales/
│   ├── en/messages.json       # Chrome i18n — extension name/description
│   └── zh_CN/messages.json
├── icons/                     # Extension icons (16/48/128 px)
└── README.md
```

### Design Patterns Used

| Pattern | Where | Purpose |
|---|---|---|
| **Module (IIFE)** | All `lib/` and `content/` scripts | Clean globals in the shared content-script world; no ES-module issues. |
| **Strategy** | `ProviderRegistry` + `background.js` | Swap LLM provider/endpoint without changing call-site code. |
| **Façade** | `StorageManager` | Single API over `chrome.storage.local` + `sync`, including timestamp-based conflict resolution. |
| **Observer / Mediator** | Chrome message passing | Popup ↔ Background ↔ Content communication via typed messages. |
| **Template Method** | `FormFillerAgent.start()` | Fixed algorithm skeleton (extract → value → fill → correct) with swappable LLM calls. |
| **Agent Loop** | `InteractionHandler` | Iterative observe → reason → act loop for multi-step dynamic UI interaction. |

---

## 🌐 Supported Providers

| Provider | Default Model | API Endpoint |
|---|---|---|
| **OpenRouter** | `openai/gpt-5.2` | `https://openrouter.ai/api/v1/chat/completions` |
| **OpenAI** | `gpt-5.2` | `https://api.openai.com/v1/chat/completions` |
| **Gemini** | `gemini-3-flash-preview` | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| **Qwen** | `qwen3.5-plus` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |

You can enter **any** model ID offered by the selected provider.

---

## 🔒 Privacy Policy

**Last Updated: February 26, 2026**

### English

1. **Information Collected** — User Profile text, API keys, and form-field context from the active page.
2. **Usage** — Data is sent only to the LLM provider you configure, solely to fill forms or generate content.
3. **Storage** — Stored via `chrome.storage.local` and `chrome.storage.sync` (managed by Google).
4. **Sharing** — Data is only shared with the LLM API provider whose key you entered. We do **not** sell or share data with any other party.
5. **Transmission** — All API calls use HTTPS.
6. **Control** — You can view, edit, or delete all stored data at any time from the extension popup.

### 中文版本

1. **收集的信息** — 用户画像文本、API 密钥以及当前页面的表单字段上下文。
2. **使用方式** — 数据仅发送到您配置的 LLM 服务商，用于填写表单或生成内容。
3. **存储** — 通过 `chrome.storage.local` 和 `chrome.storage.sync` 存储（由 Google 管理）。
4. **共享** — 数据仅与您输入密钥的 LLM 服务商共享。我们**不会**向任何其他方出售或共享数据。
5. **传输** — 所有 API 调用均使用 HTTPS。
6. **控制** — 您可以随时在扩展弹窗中查看、编辑或删除所有存储的数据。

---

## 📝 Changelog

### v2.0

- **Refactored** entire codebase into `lib/`, `content/`, `popup/` modules.
- **Added** runtime language switching (English ↔ 中文).
- **Added** multi-provider support: OpenRouter, OpenAI, Gemini, Qwen.
- **Added** per-provider API key and model ID persistence.
- **Removed** mem0 integration (was disabled) and DeepSeek/GLM direct endpoints.
- **Improved** `StorageManager` facade eliminating duplicated local/sync logic.
- **Improved** popup UI with header, language toggle, and cleaner layout.
- **Improved** code documentation and separation of concerns.
- **Added** LLM-driven interaction agent loop for dynamic multi-step widgets.

### v1.1

- Initial public release with form filling, quick query, and mem0 support.
