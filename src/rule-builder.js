/**
 * Shared storage key so popup/background stay in sync.
 */
export const BLOCKED_ENTRIES_KEY = "blockedEntries";
export const BLOCK_LOGS_KEY = "blockedLogs";
export const RULE_ID_TO_ENTRY_KEY = "ruleIdToEntryKey";
export const MASTER_PIN_HASH_KEY = "masterPinHash";

/**
 * Types of entries users can add from the popup.
 */
export const ENTRY_TYPES = {
  DOMAIN: "domain",
  PATTERN: "pattern"
};

export const ENTRY_ACTIONS = {
  BLOCK: "block",
  HIDE_ELEMENTS: "hide-elements"
};

/**
 * Keep dynamic rule IDs in a known range to avoid collisions.
 */
const RULE_ID_OFFSET = 10_000;

/**
 * Declarative Net Request only allows a finite number of dynamic rules.
 */
export const MAX_DYNAMIC_RULES = 5_000;
export const MAX_RECENT_BLOCKED_SITES = 20;

/**
 * Resource types to block. Including main_frame blocks page navigation itself.
 */
const BLOCKED_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "stylesheet",
  "image",
  "font",
  "media",
  "websocket",
  "other"
];
const MAIN_FRAME_RESOURCE_TYPES = ["main_frame"];
const NON_MAIN_RESOURCE_TYPES = BLOCKED_RESOURCE_TYPES.filter((type) => type !== "main_frame");
const BLOCK_PAGE_EXTENSION_PATH = "/blocked.html";

/**
 * Normalize incoming user entries and discard invalid rows.
 */
export function normalizeEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const keyToIndex = new Map();
  const normalized = [];

  for (const rawEntry of rawEntries) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const type = rawEntry.type;
    const rawValue = String(rawEntry.value ?? "").trim();
    if (!rawValue) {
      continue;
    }

    if (type === ENTRY_TYPES.DOMAIN) {
      const domain = normalizeDomain(rawValue);
      if (!domain) {
        continue;
      }
      const nextEntry = buildNormalizedEntry({ type: ENTRY_TYPES.DOMAIN, value: domain }, rawEntry);
      upsertNormalizedEntry(normalized, keyToIndex, nextEntry);
      continue;
    }

    if (type === ENTRY_TYPES.PATTERN) {
      const pattern = rawValue;
      const nextEntry = buildNormalizedEntry({ type: ENTRY_TYPES.PATTERN, value: pattern }, rawEntry);
      upsertNormalizedEntry(normalized, keyToIndex, nextEntry);
    }
  }

  return normalized.slice(0, MAX_DYNAMIC_RULES);
}

function buildNormalizedEntry(baseEntry, rawEntry) {
  const expiresAt = normalizeExpiry(rawEntry?.expiresAt);
  const requiresMasterPin = normalizeProtectedRule(rawEntry?.requiresMasterPin);
  const action = normalizeEntryAction(rawEntry?.action);
  const selectors = normalizeSelectors(rawEntry?.selectors);

  let nextEntry = { ...baseEntry, action };
  if (expiresAt) {
    nextEntry = { ...nextEntry, expiresAt };
  }
  if (requiresMasterPin) {
    nextEntry = { ...nextEntry, requiresMasterPin: true };
  }
  if (action === ENTRY_ACTIONS.HIDE_ELEMENTS && selectors.length > 0) {
    nextEntry = { ...nextEntry, selectors };
  }

  return nextEntry;
}

function upsertNormalizedEntry(normalized, keyToIndex, entry) {
  const key = entryKeyFromEntry(entry);
  const existingIndex = keyToIndex.get(key);
  if (typeof existingIndex === "number") {
    normalized[existingIndex] = entry;
    return;
  }

  keyToIndex.set(key, normalized.length);
  normalized.push(entry);
}

/**
 * Convert user entries into Chrome DNR dynamic block rules.
 */
export function buildDynamicRules(entries) {
  return buildRuleRecords(entries).map((record) => record.rule);
}

/**
 * Stable key used to bucket logs by logical rule.
 */
export function entryKeyFromEntry(entry) {
  return `${entry.type}:${entry.value}`;
}

/**
 * Build a map so runtime rule IDs can be traced back to logical entry keys.
 */
export function buildRuleIdToEntryKeyMap(entries) {
  const mapping = {};
  buildRuleRecords(entries).forEach((record) => {
    mapping[String(record.rule.id)] = record.entryKey;
  });

  return mapping;
}

function buildRuleRecords(entries) {
  const records = [];
  let nextRuleId = RULE_ID_OFFSET;

  const blockEntries = normalizeEntries(entries).filter(
    (entry) => entry.action !== ENTRY_ACTIONS.HIDE_ELEMENTS
  );

  for (const entry of blockEntries) {
    if (records.length >= MAX_DYNAMIC_RULES) {
      break;
    }

    const entryKey = entryKeyFromEntry(entry);
    records.push({
      entryKey,
      rule: {
        id: nextRuleId++,
        priority: 2,
        action: { type: "redirect", redirect: { extensionPath: BLOCK_PAGE_EXTENSION_PATH } },
        condition: buildConditionFromEntry(entry, MAIN_FRAME_RESOURCE_TYPES)
      }
    });

    if (records.length >= MAX_DYNAMIC_RULES) {
      break;
    }

    records.push({
      entryKey,
      rule: {
        id: nextRuleId++,
        priority: 1,
        action: { type: "block" },
        condition: buildConditionFromEntry(entry, NON_MAIN_RESOURCE_TYPES)
      }
    });
  }

  return records;
}

function buildConditionFromEntry(entry, resourceTypes) {
  if (entry.type === ENTRY_TYPES.DOMAIN) {
    // ||example.com^ means "any scheme + any subdomain for this registrable host".
    return {
      urlFilter: `||${entry.value}^`,
      resourceTypes
    };
  }

  return {
    regexFilter: wildcardPatternToRegex(entry.value),
    resourceTypes
  };
}

/**
 * Normalize optional expiration timestamps.
 */
export function normalizeExpiry(rawExpiresAt) {
  if (rawExpiresAt == null || rawExpiresAt === "") {
    return null;
  }

  const timestamp = Date.parse(String(rawExpiresAt));
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

/**
 * Expired entries are ignored by dynamic rule sync.
 */
export function isEntryActive(entry, nowMs = Date.now()) {
  if (!entry?.expiresAt) {
    return true;
  }

  const timestamp = Date.parse(entry.expiresAt);
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

/**
 * Convenience helper used by popup/background flows.
 */
export function filterActiveEntries(entries, nowMs = Date.now()) {
  return normalizeEntries(entries).filter((entry) => isEntryActive(entry, nowMs));
}

function normalizeProtectedRule(rawValue) {
  return rawValue === true || rawValue === "true" || rawValue === 1 || rawValue === "1";
}

function normalizeEntryAction(rawAction) {
  return rawAction === ENTRY_ACTIONS.HIDE_ELEMENTS ? ENTRY_ACTIONS.HIDE_ELEMENTS : ENTRY_ACTIONS.BLOCK;
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

/**
 * Convert a wildcard pattern (where * means "any chars") into a safe regex.
 * Example: *://*.example.com/* -> ^.*://.*\.example\.com/.*$
 */
export function wildcardPatternToRegex(pattern) {
  const trimmed = String(pattern).trim();
  if (!trimmed) {
    return "^$";
  }

  // Prefer parsing match-like patterns: <scheme>://<host>/<path>
  const parts = trimmed.match(/^([^/]+):\/\/([^/]+)(\/.*)$/);
  if (parts) {
    const [, schemePart, hostPart, pathPart] = parts;
    const schemeRegex = escapeRegexExceptStar(schemePart).replace(/\*/g, ".*");
    const hostRegex = escapeRegexExceptStar(hostPart).replace(/\*/g, ".*");
    const pathRegex = escapeRegexExceptStar(pathPart).replace(/\*/g, ".*");
    const optionalPortRegex = hostPart.includes(":") ? "" : "(?::[0-9]+)?";
    return `^${schemeRegex}://${hostRegex}${optionalPortRegex}${pathRegex}$`;
  }

  // Fallback: treat value as a simple wildcard over the full URL string.
  return `^${escapeRegexExceptStar(trimmed).replace(/\*/g, ".*")}$`;
}

function escapeRegexExceptStar(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Loose domain sanitizer for human-friendly input.
 * Accepts values like "https://example.com/path" or "example.com".
 */
export function normalizeDomain(input) {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  try {
    const asUrl = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    const hostname = asUrl.hostname.replace(/^www\./, "");
    return isValidDomainHost(hostname) ? hostname : "";
  } catch {
    return "";
  }
}

function isValidDomainHost(hostname) {
  if (!hostname) {
    return false;
  }

  if (hostname === "localhost") {
    return true;
  }

  // Accept IPv4 hosts (e.g. 127.0.0.1).
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    return hostname.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    return false;
  }

  return labels.every((label) => {
    if (!label || label.length > 63) {
      return false;
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return false;
    }
    return !label.startsWith("-") && !label.endsWith("-");
  });
}
