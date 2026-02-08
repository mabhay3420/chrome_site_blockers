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

  let nextEntry = { ...baseEntry };
  if (expiresAt) {
    nextEntry = { ...nextEntry, expiresAt };
  }
  if (requiresMasterPin) {
    nextEntry = { ...nextEntry, requiresMasterPin: true };
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
  return normalizeEntries(entries).map((entry, index) => {
    const ruleId = RULE_ID_OFFSET + index;

    if (entry.type === ENTRY_TYPES.DOMAIN) {
      // ||example.com^ means "any scheme + any subdomain for this registrable host".
      return {
        id: ruleId,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: `||${entry.value}^`,
          resourceTypes: BLOCKED_RESOURCE_TYPES
        }
      };
    }

    // Pattern entries use regexFilter so users can provide match-like wildcard input.
    return {
      id: ruleId,
      priority: 1,
      action: { type: "block" },
      condition: {
        regexFilter: wildcardPatternToRegex(entry.value),
        resourceTypes: BLOCKED_RESOURCE_TYPES
      }
    };
  });
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

  normalizeEntries(entries).forEach((entry, index) => {
    mapping[String(RULE_ID_OFFSET + index)] = entryKeyFromEntry(entry);
  });

  return mapping;
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
