const BLOCKED_ENTRIES_KEY = "blockedEntries";
const ENTRY_TYPES = {
  DOMAIN: "domain",
  PATTERN: "pattern"
};
const ENTRY_ACTIONS = {
  HIDE_ELEMENTS: "hide-elements"
};
const STYLE_ATTRIBUTE = "data-site-blocker-hide-style";

let activeHideEntries = [];
let lastKnownHref = location.href;

init().catch((error) => {
  console.error("Site Blocker content script initialization failed", error);
});

async function init() {
  const storage = await chrome.storage.local.get(BLOCKED_ENTRIES_KEY);
  activeHideEntries = buildActiveHideEntries(storage[BLOCKED_ENTRIES_KEY]);
  applyHideRulesForCurrentPage();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(BLOCKED_ENTRIES_KEY in changes)) {
      return;
    }

    activeHideEntries = buildActiveHideEntries(changes[BLOCKED_ENTRIES_KEY]?.newValue);
    applyHideRulesForCurrentPage();
  });

  window.addEventListener("hashchange", applyHideRulesForCurrentPage);
  window.addEventListener("popstate", applyHideRulesForCurrentPage);

  // Catch SPA route changes that do not emit popstate/hashchange reliably.
  setInterval(() => {
    if (location.href === lastKnownHref) {
      return;
    }
    lastKnownHref = location.href;
    applyHideRulesForCurrentPage();
  }, 600);
}

function buildActiveHideEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const nowMs = Date.now();
  const normalized = [];

  rawEntries.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }

    if (entry.action !== ENTRY_ACTIONS.HIDE_ELEMENTS) {
      return;
    }

    const type = entry.type;
    const value = String(entry.value ?? "").trim();
    if (!value || (type !== ENTRY_TYPES.DOMAIN && type !== ENTRY_TYPES.PATTERN)) {
      return;
    }

    const expiryMs = entry.expiresAt ? Date.parse(String(entry.expiresAt)) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(expiryMs) && entry.expiresAt) {
      return;
    }
    if (expiryMs <= nowMs) {
      return;
    }

    const selectors = normalizeSelectors(entry.selectors).filter(isValidCssSelector);
    if (selectors.length === 0) {
      return;
    }

    normalized.push({
      type,
      value: type === ENTRY_TYPES.DOMAIN ? value.toLowerCase() : value,
      selectors
    });
  });

  return normalized;
}

function normalizeSelectors(rawSelectors) {
  const source = Array.isArray(rawSelectors)
    ? rawSelectors
    : String(rawSelectors ?? "")
        .split(/\r?\n|,/)
        .map((selector) => selector.trim());

  const unique = [];
  const seen = new Set();

  source.forEach((selector) => {
    if (!selector || seen.has(selector)) {
      return;
    }
    seen.add(selector);
    unique.push(selector);
  });

  return unique.slice(0, 30);
}

function isValidCssSelector(selector) {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function applyHideRulesForCurrentPage() {
  removeManagedStyles();

  const currentUrl = location.href;
  const currentHost = location.hostname.toLowerCase();
  const matched = activeHideEntries.filter((entry) => matchesPage(entry, currentUrl, currentHost));

  if (matched.length === 0) {
    return;
  }

  matched.forEach((entry, index) => {
    const style = document.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "1");
    style.setAttribute("data-site-blocker-entry-index", String(index));

    style.textContent = entry.selectors
      .map((selector) => `${selector} { display: none !important; visibility: hidden !important; }`)
      .join("\n");

    const styleRoot = document.head || document.documentElement;
    styleRoot.appendChild(style);
  });
}

function removeManagedStyles() {
  document.querySelectorAll(`style[${STYLE_ATTRIBUTE}="1"]`).forEach((node) => node.remove());
}

function matchesPage(entry, url, host) {
  if (entry.type === ENTRY_TYPES.DOMAIN) {
    return host === entry.value || host.endsWith(`.${entry.value}`);
  }

  try {
    return new RegExp(wildcardPatternToRegex(entry.value)).test(url);
  } catch {
    return false;
  }
}

function wildcardPatternToRegex(pattern) {
  const trimmed = String(pattern).trim();
  if (!trimmed) {
    return "^$";
  }

  const parts = trimmed.match(/^([^/]+):\/\/([^/]+)(\/.*)$/);
  if (parts) {
    const [, schemePart, hostPart, pathPart] = parts;
    const schemeRegex = escapeRegexExceptStar(schemePart).replace(/\*/g, ".*");
    const hostRegex = escapeRegexExceptStar(hostPart).replace(/\*/g, ".*");
    const pathRegex = escapeRegexExceptStar(pathPart).replace(/\*/g, ".*");
    const optionalPortRegex = hostPart.includes(":") ? "" : "(?::[0-9]+)?";
    return `^${schemeRegex}://${hostRegex}${optionalPortRegex}${pathRegex}$`;
  }

  return `^${escapeRegexExceptStar(trimmed).replace(/\*/g, ".*")}$`;
}

function escapeRegexExceptStar(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
