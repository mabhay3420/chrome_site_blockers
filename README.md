# Minimal Chrome Site Blocker

A minimal Manifest V3 Chrome extension that blocks:
- Exact domains (example: `example.com`)
- Wildcard URL patterns (example: `*://*.example.com/*`)

The popup UI uses a code-style font stack for a compact, developer-friendly look.

## Features

- Add/remove rules from popup
- Timed rules: indefinite (default), preset windows, or custom duration
- Fuzzy autocomplete for 20 curated distracting sites (including programmer-heavy ones)
- Optional protected-removal mode per rule (requires master PIN to delete)
- Settings panel to set/change a single global 6-digit master PIN
- Compact current-rules chips (click a chip to open details)
- Rules stored in `chrome.storage.local`
- Blocking enforced via `chrome.declarativeNetRequest` dynamic rules
- Per-rule recent blocked-site logging (bucketed by rule)
- Clear, commented source code for extension beginners
- Full Playwright E2E tests

## Project Structure

- `manifest.json`: Extension metadata and permissions
- `background.js`: Syncs storage entries to dynamic DNR rules
- `popup.html`: Popup markup
- `popup.css`: Minimal polished UI styling (code-like font stack)
- `popup.js`: Popup behavior + validation
- `src/rule-builder.js`: Shared normalization/rule conversion logic
- `tests/e2e/blocker.spec.js`: End-to-end extension tests

## Install in Chrome / Chromium-Based Browsers

### Google Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this project folder (`chrome_site_blockers`)
5. (Optional) Click the puzzle icon, then pin **Minimal Site Blocker**
6. Open the extension popup and add rules

### Microsoft Edge

1. Open `edge://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

### Brave

1. Open `brave://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

### Arc / Vivaldi / Opera (Chromium-based)

1. Open the browser extensions page (usually via `...://extensions` or browser settings)
2. Enable developer mode for extensions
3. Choose **Load unpacked**
4. Select this project folder

If your browser supports Chrome extensions, these unpacked-install steps are usually the same.

## Usage

### Block a domain
- Type: `domain`
- Value: `example.com`

### Block a wildcard pattern
- Type: `pattern`
- Value: `*://*.example.com/*`

### Choose block duration
- `Indefinite` (default)
- `15m`
- `30m`
- `Next 1 hour`
- `Next 4 hours`
- `Next 1 day`
- `Custom` with `second(s)`, `minute(s)`, `hour(s)`, or `day(s)`
- Custom value controls appear only when `Custom` is selected.

If you add an existing rule again (same domain/pattern), the rule is updated with the new duration.
If the same rule is added with multiple durations, the longest duration is kept.

### Smart autocomplete
- In `domain` mode, typing initials or fuzzy text opens suggestions.
- Example: typing `twitter` suggests `x.com`; typing `ig` suggests `instagram.com`.
- Suggestions are based on a curated list of 20 commonly distracting sites.

### Protected removal with master PIN
- Open `Settings` in the popup to set a 6-digit master PIN.
- First time: set a new PIN directly.
- Later changes: set a new PIN directly (no current PIN prompt).
- While adding a rule, enable `Require master PIN to remove this rule` if needed.
- Deleting protected rules asks for a 6-digit PIN in OTP-style input boxes.
- Emergency remove override PIN: `456789` (use only if you forget your configured PIN).

## Run Automated Tests

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

## Notes

- Domain rules are normalized (for example, `https://www.example.com/path` becomes `example.com`).
- Re-adding an existing rule updates that rule's duration.
- For repeated adds of the same rule, shortest durations never reduce an existing longer one.
- Removing a rule updates Chrome dynamic rules immediately.
- Expired timed rules are automatically removed and stop blocking.
- Master PIN is stored as a SHA-256 hash in `chrome.storage.local` (`masterPinHash`).
- Block logs are stored under `blockedLogs` in `chrome.storage.local`, bucketed by keys like `domain:example.com` or `pattern:*://*.example.com/*`.
- Logging uses DNR match debug events, which are available for unpacked/developer-loaded extensions.
