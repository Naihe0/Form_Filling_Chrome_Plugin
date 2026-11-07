# Changelog

## 3.0.0 — 2026-11-07

A rewrite around a new harness. See [docs/HARNESS.md](docs/HARNESS.md).

### Changed

- **The model no longer reads HTML or writes CSS selectors.** A deterministic scan produces a list of fields, and the model answers by id.
- **Every write is read back.** Reports state what the page actually holds, and a final audit catches fields reset by later fills.
- **The extension is now built.** Run `npm install && npm run build` and load `dist/` instead of the repository root.
- **Written in TypeScript**, with no runtime dependencies.
- The default provider is Gemini, with the `gemini-flash-latest` alias.
- Forms on a tab are now filled in every frame, including cross-origin iframes, and in open shadow roots.
- Fields revealed by earlier answers are filled in later passes.
- Custom dropdowns and cascaders are filled without a model call when an option matches exactly.
- Reports show what needs your attention, and clicking an item on the page scrolls to it.
- Calls stream, use low reasoning effort, and retry transient failures. Parameters a model rejects are dropped automatically, so any model id works.
- The popup supports dark mode.

### Added

- **Safety policy enforced in code:** passwords, payment details, one-time codes, CAPTCHAs, consent boxes and file uploads are never touched. Submit, pay and delete buttons and links away from the page are never clicked. Honeypot fields are ignored.
- *Overwrite existing values* toggle. By default, fields already holding a value are left alone.
- Evaluation suite that scores runs against a live model, and a real-browser test suite.

### Fixed

- **Option matching used bare substrings.** `不同意` could select `同意`. Options are now answered by id.
- **A second run on the same page did nothing** until the page was reloaded.
- **Stop did not stop.** It set a flag that the widget loop never checked, and calls in flight kept running. It now cancels the network request.
- `done` from the model was believed without checking.
- A model that rejected the hard-coded `temperature` failed the whole run.
- A profile over 8 KB failed to sync silently.
- A failed start could leave the popup stuck on the spinner.
- Quick Query fired in password and payment fields, and overwrote text typed while the model was thinking.
- Re-injecting scripts threw a redeclaration error and omitted the interaction handler.

### Security

- API keys are no longer written to `chrome.storage.sync`, and are removed from there on upgrade.
- API keys and the profile no longer reach content scripts, which share a process with the page. Storage is restricted to trusted contexts.
- Raw HTML, hidden inputs and existing field values are no longer sent to the provider.
- Remote Google Fonts removed from the popup.
- Nothing is injected into a page until you press Start. Quick Query is registered only while enabled.

### Removed

- *Reasoning Correction* toggle. It only changed a timeout; repair and verification now always run.
- Page-level `alert()` dialogs.

### Migration

Chrome Web Store updates migrate settings, keys and your profile automatically on first run. An unpacked install now loads from `dist/`, which Chrome treats as a new extension, so copy your profile and keys across by hand.

## 2.0

- Refactored the codebase into `lib/`, `content/` and `popup/` modules.
- Added runtime language switching (English and 中文).
- Added providers: OpenRouter, OpenAI, Gemini, Qwen, with per-provider key and model.
- Added an LLM-driven agent loop for dynamic widgets.
- Removed the disabled mem0 integration, and the DeepSeek and GLM endpoints.

## 1.1

- First public release, with form filling, Quick Query and mem0 support.
