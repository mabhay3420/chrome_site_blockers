import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const extensionPath = path.resolve(process.cwd());

let server;
let serverPort;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url?.startsWith("/advanced-elements")) {
      res.end(`<!doctype html>
        <html>
          <body>
            <h1>ok:${req.url}</h1>
            <section id="related">related videos</section>
            <section id="comments">comments block</section>
            <section id="keep">stay visible</section>
          </body>
        </html>`);
      return;
    }

    res.end(`<!doctype html><html><body><h1>ok:${req.url}</h1></body></html>`);
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  serverPort = typeof address === "object" && address ? address.port : 0;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function launchWithExtension(userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Extension loading is reliably supported in Chromium channel when headed.
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    // On slower machines the extension worker can take a moment to spin up.
    worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  }

  const extensionId = new URL(worker.url()).hostname;
  return { context, extensionId };
}

async function openPopup(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

async function addRule(popup, type, value, options = {}) {
  await popup.selectOption("#entry-type", type);
  await popup.fill("#entry-value", value);

  const shouldProtect = options.requiresMasterPin === true;
  const checkbox = popup.locator("#requires-master-pin");
  if ((await checkbox.isChecked()) !== shouldProtect) {
    await checkbox.click();
  }

  if (options.durationPreset) {
    await popup.click(`#duration-template-${options.durationPreset}`);
  }

  if (options.durationPreset === "custom") {
    if (options.customValue != null) {
      await popup.fill("#custom-duration-value", String(options.customValue));
    }
    if (options.customUnit) {
      await popup.selectOption("#custom-duration-unit", options.customUnit);
    }
  }

  const shouldUseAdvanced = Array.isArray(options.advancedSelectors) && options.advancedSelectors.length > 0;
  const advancedCheckbox = popup.locator("#use-advanced-options");
  if ((await advancedCheckbox.isChecked()) !== shouldUseAdvanced) {
    await advancedCheckbox.click();
  }

  if (shouldUseAdvanced) {
    await popup.fill("#entry-selectors", options.advancedSelectors.join("\n"));
  }

  await popup.click("button[type='submit']");
}

async function fillOtp(popup, prefix, value) {
  const digits = String(value).replace(/\D/g, "").padEnd(6, "0").slice(0, 6);
  for (let index = 0; index < 6; index += 1) {
    await popup.fill(`#${prefix}-pin-${index}`, digits[index]);
  }
}

async function setMasterPin(popup, newPin) {
  await popup.click("#settings-toggle");
  await fillOtp(popup, "new", newPin);

  await popup.click("#save-master-pin");
  await expect(popup.locator("#settings-message")).toContainText("Master PIN saved.");
  await popup.click("#settings-close");
}

async function getStoredRuleEntry(popup, type, value) {
  return popup.evaluate(
    async ({ type: ruleType, value: ruleValue }) => {
      const storage = await chrome.storage.local.get("blockedEntries");
      return (
        (storage.blockedEntries || []).find(
          (entry) => entry?.type === ruleType && entry?.value === ruleValue
        ) || null
      );
    },
    { type, value }
  );
}

async function expandRuleByValue(popup, value) {
  const chip = popup
    .locator(".entry-chip", {
      has: popup.locator("code.entry-chip__value", { hasText: value })
    })
    .first();
  await chip.click();
}

async function waitForRuleCount(popup, expectedCount, timeout = 5_000) {
  await expect
    .poll(
      async () => {
        return popup.evaluate(async () => {
          const rules = await chrome.declarativeNetRequest.getDynamicRules();
          return rules.length;
        });
      },
      { timeout }
    )
    .toBe(expectedCount);
}

async function waitForLogHit(popup, entryKey, expectedSite) {
  await expect
    .poll(async () => {
      return popup.evaluate(
        async ({ key, site }) => {
          const storage = await chrome.storage.local.get("blockedLogs");
          const bucket = storage.blockedLogs?.[key];
          if (!Array.isArray(bucket)) {
            return false;
          }
          return bucket.some((item) => item?.site === site && Number(item?.count || 0) >= 1);
        },
        { key: entryKey, site: expectedSite }
      );
    })
    .toBe(true);
}

async function expectBlocked(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/blocked\.html$/);
  await expect(page.locator("h1")).toContainText("That site can wait.");
}

test("blocks exact domain rule from popup", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-domain-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "localhost");
    await waitForRuleCount(popup, 2);

    const page = await context.newPage();
    await expectBlocked(page, `http://localhost:${serverPort}/domain-check`);
    await waitForLogHit(popup, "domain:localhost", "localhost");
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("blocks wildcard pattern rule from popup", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-pattern-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "pattern", "*://127.0.0.1/*");
    await waitForRuleCount(popup, 2);

    const page = await context.newPage();
    await expectBlocked(page, `http://127.0.0.1:${serverPort}/pattern-check`);
    await waitForLogHit(popup, "pattern:*://127.0.0.1/*", "127.0.0.1");
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("shows fuzzy autocomplete suggestions for curated sites", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-autocomplete-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await popup.fill("#entry-value", "twitter");

    const suggestion = popup.locator("button.suggestion-item", {
      has: popup.locator("code.suggestion-item__domain", { hasText: "x.com" })
    });

    await expect(suggestion).toBeVisible();
    await popup.locator("#entry-value").press("Tab");
    await expect(popup.locator("#entry-value")).toHaveValue("x.com");

    await popup.click("button[type='submit']");
    await waitForRuleCount(popup, 2);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("advanced selector templates fill youtube and x.com selectors", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-template-fill-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await popup.click("#use-advanced-options");

    await popup.click("#youtube-template");
    await popup.click("#x-template");

    const selectorsValue = await popup.inputValue("#entry-selectors");
    expect(selectorsValue).toContain("#related");
    expect(selectorsValue).toContain("button[aria-label*='Notifications']");
    expect(selectorsValue).toContain("ytd-rich-shelf-renderer");
    expect(selectorsValue).toContain("[data-testid='sidebarColumn']");
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("shows error when protected rule is added without master pin", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-protect-no-pin-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "localhost", { requiresMasterPin: true });
    await expect(popup.locator("#message")).toContainText("Set a master PIN in Settings");
    await waitForRuleCount(popup, 0);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("protected rule requires PIN and supports emergency override", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-protected-remove-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await setMasterPin(popup, "123456");
    await addRule(popup, "domain", "localhost", { requiresMasterPin: true });
    await waitForRuleCount(popup, 2);

    await expandRuleByValue(popup, "localhost");
    await popup.click(".entry-item__remove");
    await expect(popup.locator("#pin-modal")).toBeVisible();

    await fillOtp(popup, "remove", "000000");
    await popup.click("#pin-confirm");
    await expect(popup.locator("#pin-modal-message")).toContainText("Incorrect PIN");
    await waitForRuleCount(popup, 2);

    await fillOtp(popup, "remove", "456789");
    await popup.click("#pin-confirm");
    await waitForRuleCount(popup, 0);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("master PIN can be reset without entering previous PIN", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-master-pin-reset-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await setMasterPin(popup, "123456");
    await setMasterPin(popup, "654321");

    await addRule(popup, "domain", "localhost", { requiresMasterPin: true });
    await waitForRuleCount(popup, 2);
    await expandRuleByValue(popup, "localhost");
    await popup.click(".entry-item__remove");
    await expect(popup.locator("#pin-modal")).toBeVisible();

    await fillOtp(popup, "remove", "123456");
    await popup.click("#pin-confirm");
    await expect(popup.locator("#pin-modal-message")).toContainText("Incorrect PIN");
    await waitForRuleCount(popup, 2);

    await fillOtp(popup, "remove", "654321");
    await popup.click("#pin-confirm");
    await waitForRuleCount(popup, 0);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("same rule keeps the longest duration when added repeatedly", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-longest-duration-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "localhost", { durationPreset: "30m" });
    await waitForRuleCount(popup, 2);

    const firstEntry = await getStoredRuleEntry(popup, "domain", "localhost");
    expect(firstEntry).not.toBeNull();
    const firstExpiryMs = Date.parse(firstEntry.expiresAt);
    expect(Number.isFinite(firstExpiryMs)).toBe(true);

    await addRule(popup, "domain", "localhost", { durationPreset: "15m" });
    const secondEntry = await getStoredRuleEntry(popup, "domain", "localhost");
    const secondExpiryMs = Date.parse(secondEntry.expiresAt);
    expect(secondExpiryMs).toBeGreaterThanOrEqual(firstExpiryMs - 1000);

    await addRule(popup, "domain", "localhost", { durationPreset: "indefinite" });
    const thirdEntry = await getStoredRuleEntry(popup, "domain", "localhost");
    expect(thirdEntry?.expiresAt).toBeUndefined();

    await addRule(popup, "domain", "localhost", { durationPreset: "15m" });
    const fourthEntry = await getStoredRuleEntry(popup, "domain", "localhost");
    expect(fourthEntry?.expiresAt).toBeUndefined();
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("stores blocked logs bucketed by rule key", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-buckets-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "localhost");
    await addRule(popup, "pattern", "*://127.0.0.1/*");
    await waitForRuleCount(popup, 4);

    const page = await context.newPage();
    await expectBlocked(page, `http://localhost:${serverPort}/bucket-check`);
    await waitForLogHit(popup, "domain:localhost", "localhost");

    const hasPatternHit = await popup.evaluate(async () => {
      const storage = await chrome.storage.local.get("blockedLogs");
      const bucket = storage.blockedLogs?.["pattern:*://127.0.0.1/*"];
      return Array.isArray(bucket) && bucket.length > 0;
    });

    expect(hasPatternHit).toBe(false);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("custom timed rule expires and unblocks automatically", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-expiry-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "localhost", {
      durationPreset: "custom",
      customValue: 3,
      customUnit: "second"
    });
    await waitForRuleCount(popup, 2);

    const blockedPage = await context.newPage();
    await expectBlocked(blockedPage, `http://localhost:${serverPort}/timed-check`);

    await waitForRuleCount(popup, 0, 20_000);

    const allowedPage = await context.newPage();
    const response = await allowedPage.goto(`http://localhost:${serverPort}/timed-expired`, {
      waitUntil: "domcontentloaded"
    });

    expect(response?.status()).toBe(200);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("removing a rule unblocks navigation", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-remove-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "localhost");
    await waitForRuleCount(popup, 2);

    await expandRuleByValue(popup, "localhost");
    await popup.click(".entry-item__remove");
    await waitForRuleCount(popup, 0);

    const page = await context.newPage();
    const response = await page.goto(`http://localhost:${serverPort}/after-remove`, {
      waitUntil: "domcontentloaded"
    });

    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toContainText("ok:/after-remove");
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("rule is persisted across browser restarts", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-persist-"));

  try {
    const first = await launchWithExtension(userDataDir);
    const popup = await openPopup(first.context, first.extensionId);
    await addRule(popup, "domain", "localhost");
    await waitForRuleCount(popup, 2);
    await first.context.close();

    const second = await launchWithExtension(userDataDir);
    try {
      const page = await second.context.newPage();
      await expectBlocked(page, `http://localhost:${serverPort}/after-restart`);
    } finally {
      await second.context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("shows validation error for invalid domain", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-validation-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "not a real domain value");

    await expect(popup.locator("#message")).toContainText("Enter a valid domain");
    await waitForRuleCount(popup, 0);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("advanced mode hides selected elements without blocking the page", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "site-blocker-advanced-hide-"));
  const { context, extensionId } = await launchWithExtension(userDataDir);

  try {
    const popup = await openPopup(context, extensionId);
    await addRule(popup, "domain", "localhost", {
      advancedSelectors: ["#related", "#comments"]
    });

    await waitForRuleCount(popup, 0);

    const page = await context.newPage();
    const response = await page.goto(`http://localhost:${serverPort}/advanced-elements`, {
      waitUntil: "domcontentloaded"
    });

    expect(response?.status()).toBe(200);
    await expect(page.locator("#keep")).toBeVisible();
    await expect(page.locator("#related")).toHaveCSS("display", "none");
    await expect(page.locator("#comments")).toHaveCSS("display", "none");
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
