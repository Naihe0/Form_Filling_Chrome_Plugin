# AI Form Filler

A Chrome extension that fills web forms from a profile you write in plain language, using an LLM with your own API key.

[中文说明](README.zh-CN.md)

You describe yourself once. On any form, press **Start Filling**, review what it entered, and submit it yourself. It handles native controls, custom dropdowns, cascaders, calendars, survey widgets, embedded frames and fields that appear as you answer, and is [evaluated against real Ant Design, Material UI and Element Plus forms](docs/TESTING.md#latest-results).

## What makes it trustworthy

- **It checks its own work.** Every value is read back from the page. The report separates what it proved from what you should check.
- **It never submits.** Nor does it touch passwords, payment details, verification codes, CAPTCHAs, consent boxes or file uploads. These rules are enforced in code, so page text cannot talk the model out of them.
- **It sends little.** The model sees field labels and options, never the page's HTML, hidden inputs or the contents of other fields. [What exactly is sent](PRIVACY.md).
- **It keeps secrets out of the page.** Your key and profile stay in the extension's trusted context, and scripts running on web pages cannot read them.
- **It does not guess.** If your profile has no answer, the field stays empty and the report says so.

## Install

Requires Node 22.18 or newer, and Chrome 121 or newer.

```bash
git clone https://github.com/Naihe0/Form_Filling_Chrome_Plugin.git
```

```bash
cd Form_Filling_Chrome_Plugin
```

```bash
npm install
```

```bash
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and choose the `dist` folder.

> **Upgrading from v2?** You now load `dist/`, not the repository root, so remove the old unpacked extension first. An unpacked extension's identity depends on its folder, so it starts with empty settings: copy your profile and keys across before removing the old one. Updates through the Chrome Web Store keep their identity, and migrate everything automatically.

## Use

1. **Profile tab:** write about yourself in any language, then save. Name, contact details, education, work, preferences. Do not include passwords or card numbers.
2. **Fill tab:** choose a provider and enter your API key. Leave Model ID empty for the default.
3. On a form, click **Start Filling**.
4. Review the page. The panel lists anything needing your attention, and clicking an item scrolls to it.
5. Submit the form yourself.

**Overwrite existing values** also rewrites fields that already have content. It is off by default.

**Quick Query:** when enabled, end your text with ` ``` ` or `···` in any text field, and the model continues it using your profile.

## Providers

| Provider | Default model | Tested live |
|---|---|---|
| Gemini | `gemini-flash-latest` | Yes, [scored on every fixture](docs/TESTING.md#latest-results) |
| OpenAI | `gpt-5.2` | No |
| OpenRouter | `openai/gpt-5.2` | No |
| Qwen | `qwen3.5-plus` | No |

You can enter any model id your provider offers. All four use the same OpenAI-compatible protocol, and the extension drops any request parameter a model rejects. The untested providers should work, but have only been exercised through tests with simulated responses.

## Limits

- It fills the current page only. It never presses Next, so for multi-step forms, run it again on each step.
- It cannot reach closed shadow roots or forms drawn on a canvas.
- It cannot use widgets that ignore scripted events (those that check `isTrusted`). The report flags these.
- Option lists with no text, such as star ratings made only of icons, are not recognised.
- Prompt injection is mitigated, not eliminated. A malicious page can show a field asking for your phone number, and the model will fill it in. Nothing leaves the page until you submit, which is why reviewing matters. [Details](docs/HARNESS.md#prompt-injection).
- AI answers can be wrong. Always review before submitting.

## Develop

```bash
npm run watch
```

```bash
npm run check
```

`npm run check` runs the type check, unit tests and real-browser tests. Browser tests need Chromium once:

```bash
npx playwright install chromium
```

To score the harness against a live model:

```bash
GEMINI_API_KEY=your-key npm run eval
```

```bash
GEMINI_API_KEY=your-key npm run eval:frameworks
```

Run these with a key from your own shell. Never commit a key. See [Testing](docs/TESTING.md) for PowerShell syntax and more.

## Documentation

- [Harness design](docs/HARNESS.md): how the model is kept honest, and why.
- [Architecture](docs/ARCHITECTURE.md): processes, trust boundaries, data flow.
- [Testing](docs/TESTING.md): test tiers, the eval suite, latest results.
- [Privacy policy](PRIVACY.md)
- [Changelog](CHANGELOG.md)
