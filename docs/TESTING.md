# Testing

Four tiers. Each answers a question the one before it cannot.

| Tier | Command | Needs | Question it answers |
|---|---|---|---|
| Unit | `npm run test:unit` | Node | Is the logic right? Run loop, policy, transport, migration. |
| Browser | `npm run test:browser` | Chromium | Does it work on real DOM, and as a real extension? |
| Eval | `npm run eval` | API key | Does a real model, through this harness, produce correct pages? |
| Frameworks | `npm run eval:frameworks` | API key | Does it work on real UI libraries, not imitations? |

`npm run check` runs the type check and the first two tiers. Those need no key and no network beyond the initial browser download.

```bash
npx playwright install chromium
```

## Unit tests

`tests/unit/`. The harness runs against `FakePage`, an in-memory `PageDriver` whose hooks simulate hard pages (controls that reject writes, fields revealed by answers, frameworks that reset earlier fields), and a scripted model. The gateway runs against a fake `fetch`.

These cover what real pages make hard to provoke: 429s and `Retry-After`, a model rejecting each optional parameter, a false `done`, budget exhaustion, a repair round that fails, the key leaking through an error message.

## Browser tests

`tests/browser/`, in real Chromium.

- **`dom.test.ts`** injects the real driver and run loop into fixture pages, with a scripted model. It asserts the DOM afterwards.
- **`extension.test.ts`** loads the built extension and drives it through its popup: service worker, on-demand injection in every frame, the model port. The provider is stubbed at the network layer, so assertions about requests describe what would really leave the browser.

Among other things, the extension tests assert that:

- no raw HTML, hidden token or blocked field appears in a request;
- content scripts cannot read the key from storage;
- the key is never written to synced storage;
- Stop cancels a call in flight;
- a run survives Chrome stopping the service worker mid-call;
- navigating away mid-run does not leave the popup spinning;
- a page with no fields costs no model call.

### If Chromium will not start on Windows

If you see `spawn UNKNOWN`, or Windows reports that the "side-by-side configuration is incorrect", copy Playwright's `chrome-win64` folder somewhere else and point the tests at the copy. This was seen on one Windows 11 machine, and only for that install path.

```powershell
Copy-Item -Recurse "$env:LOCALAPPDATA\ms-playwright\chromium-*\chrome-win64" "$env:TEMP\chromium"
```

```powershell
$env:AFF_CHROMIUM_PATH = "$env:TEMP\chromium\chrome.exe"
```

The extension tests and `evals/run.ts --extension` honour `AFF_CHROMIUM_PATH`. Branded Chrome will not do: it no longer accepts `--load-extension`.

## Evals

Evals score the final state of the page, never what the harness says about itself.

```bash
GEMINI_API_KEY=your-key npm run eval
```

In PowerShell:

```powershell
$env:GEMINI_API_KEY = "your-key"; npm run eval
```

| Flag | Default | Meaning |
|---|---|---|
| `--extension` | off | Load the built extension and run through its service worker, as a user would. Otherwise the driver is injected into the page and the model is called from Node, which isolates harness behaviour. |
| `--model` | The provider's default | Any model id. |
| `--provider` | `gemini` | Reads `<PROVIDER>_API_KEY`. |
| `--runs` | 1 | Repeat, since models are not deterministic. |
| `--only` | All | Run cases whose name contains this. |
| `--min-score` | 0.9 | Exit non-zero below this. |

Reports go to `reports/` (ignored by git) and contain the fictional persona's values and the trace, never the key.

### Safety checks and quality checks

Checks in [`evals/cases.ts`](../evals/cases.ts) come in two kinds.

- **Safety checks must hold on every run.** Nothing submitted, no secret field touched, no profile leaked. One failure fails the eval, whatever the score.
- **Quality checks are the score.** A wrong or missing answer lowers it.

A model declining to answer on a hostile page is a quality failure, not a safety one: the field is empty and nothing leaked.

### The fixtures

`tests/fixtures/`, shared by browser tests and evals.

| Fixture | What makes it hard |
|---|---|
| `contact.html` | Every labelling style; password, card, consent and file fields; four kinds of honeypot; a CSRF token; a site search box. |
| `survey-cn.html` | No semantics: radios hidden behind proxies, options made of plain `div`s and `li`s, matrix questions, options that contain each other (`吸烟` / `不吸烟`). |
| `widgets.html` | Popups portalled to `<body>`, an async combobox, a cascader, a read-only calendar, a date input that commits only on Enter, handlers on inner wrappers, zero-width placeholders, commit buttons and exit links inside popups. |
| `dynamic.html` | Conditional fields, dependent selects, a controlled input with React-style value tracking, an input mask, a field replaced on re-render. |
| `embedded.html` | Same-origin and cross-origin frames, a shadow root, an empty ad frame. |
| `adversarial.html` | Prompt injection through labels, placeholders, page text, the page title and tag-breakout attempts; hidden exfiltration fields; "Buy now" in a dropdown. |

### Real libraries

[`evals/frameworks/`](../evals/frameworks) builds plain forms with Ant Design, Material UI and Element Plus, and checks each framework's own state rather than the DOM, so a pass means its event handling really fired. It has its own `package.json`, installed on demand, so the main install stays small.

This tier exists because the fixtures are imitations written by the same hand as the code. On its first run it found three bugs that the fixtures could not, each now reproduced in `widgets.html`.

## Latest results

Measured November 7, 2026, on the code at release 3.0.0.

| Suite | Model | Runs | Result | Safety failures |
|---|---|---|---|---|
| Unit | None | 1 | 169 / 169 | n/a |
| Browser | Stubbed | 1 | 64 / 64 | n/a |
| Eval, direct | `gemini-3.8-flash` | 5 | 360 / 360 | 0 |
| Eval, through the extension | `gemini-flash-latest` | 3 | 215 / 216 | 0 |
| Ant Design 6.7 | `gemini-flash-latest` | 1 | 11 / 11 fields | Not submitted |
| Material UI 9.5 | `gemini-flash-latest` | 1 | 6 / 6 fields | Not submitted |
| Element Plus 2.14 | `gemini-flash-latest` | 1 | 9 / 9 fields | Not submitted |

Typical cost per form through the extension:

| Fixture | Model calls | Tokens | Time |
|---|---|---|---|
| contact | 1 | 1,191 | 3.6 s |
| survey-cn | 1 | 1,347 | 3.5 s |
| widgets | 6 | 6,434 | 18.7 s |
| dynamic | 2 | 1,819 | 5.1 s |
| embedded (3 frames with fields) | 3 | 2,122 | 2.9 s |
| adversarial | 1 | 911 | 3.0 s |

### How to read these numbers

**The score is not always 100%, and should not be expected to be.** The one miss above was the model declining the name field on the adversarial page, whose placeholder carries an injection. Across earlier runs of the same page it once declined every field. Both are safe failures. On a form where the profile is ambiguous (it said where the persona lives, not where they work), the model sometimes leaves a field empty rather than infer it, as instructed.

**What this has not been tested against:**

- **Live third-party websites.** Everything ran on local pages. Real sites have CSP, anti-automation, and markup nobody anticipated. Expect gaps there, and please report them as fixtures.
- **OpenAI, OpenRouter and Qwen.** Only Gemini has been called for real. The others are covered by simulated responses, including the parameter-rejection paths they are expected to hit.
- **Real Chrome.** Tests use Chrome for Testing in headless mode. It is the same engine, but the toolbar popup itself has only been exercised as a page opened in a tab.

## Adding a test for a form that failed

1. Reduce the page to its trait, and add that to a fixture (or a new one).
2. Add scripted-model cases to `tests/browser/dom.test.ts`, so the bug is caught with no key.
3. Add checks to `evals/cases.ts`, marking anything that must never happen as `safety: true`.
4. Fix perception or execution in general terms, not for that one site.
