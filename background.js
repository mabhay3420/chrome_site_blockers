import {
  BLOCKED_ENTRIES_KEY,
  BLOCK_LOGS_KEY,
  MAX_RECENT_BLOCKED_SITES,
  RULE_ID_TO_ENTRY_KEY,
  filterActiveEntries,
  buildRuleIdToEntryKeyMap,
  buildDynamicRules,
  normalizeEntries
} from "./src/rule-builder.js";

const EXPIRY_ALARM_NAME = "rule-expiry-sync";
let expiryTimeoutId = null;

/**
 * Replace all dynamic block rules with the rules derived from storage.
 * This keeps rule state deterministic and easy to reason about.
 */
async function syncRulesFromStorage() {
  const storage = await chrome.storage.local.get([BLOCKED_ENTRIES_KEY, BLOCK_LOGS_KEY]);
  const entries = normalizeEntries(storage[BLOCKED_ENTRIES_KEY]);
  const activeEntries = filterActiveEntries(entries);
  const hasExpiredEntries = activeEntries.length !== entries.length;

  const nextRules = buildDynamicRules(activeEntries);
  const ruleIdToEntryKey = buildRuleIdToEntryKeyMap(activeEntries);
  const activeEntryKeys = new Set(Object.values(ruleIdToEntryKey));

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: nextRules
  });

  // Keep mapping + logs coherent with the latest active rule set.
  const currentLogs = ensureLogObject(storage[BLOCK_LOGS_KEY]);
  const prunedLogs = Object.fromEntries(
    Object.entries(currentLogs).filter(([entryKey]) => activeEntryKeys.has(entryKey))
  );

  const nextStorage = {
    [RULE_ID_TO_ENTRY_KEY]: ruleIdToEntryKey,
    [BLOCK_LOGS_KEY]: prunedLogs
  };

  if (hasExpiredEntries) {
    nextStorage[BLOCKED_ENTRIES_KEY] = activeEntries;
  }

  await chrome.storage.local.set(nextStorage);
  await scheduleNextExpiry(activeEntries);
}

/**
 * DNR debug callbacks can fire rapidly; serialize writes to avoid races.
 */
let logWriteQueue = Promise.resolve();

function enqueueBlockedLog(matchInfo) {
  logWriteQueue = logWriteQueue
    .then(() => recordBlockedRequest(matchInfo))
    .catch((error) => console.error("Failed to record blocked request", error));
}

async function recordBlockedRequest(matchInfo) {
  const ruleId = matchInfo?.rule?.ruleId;
  const blockedUrl = matchInfo?.request?.url;

  if (!Number.isInteger(ruleId) || typeof blockedUrl !== "string" || !blockedUrl) {
    return;
  }

  const storage = await chrome.storage.local.get([RULE_ID_TO_ENTRY_KEY, BLOCK_LOGS_KEY]);
  const ruleMap = storage[RULE_ID_TO_ENTRY_KEY] ?? {};
  const entryKey = ruleMap[String(ruleId)];
  if (!entryKey) {
    return;
  }

  const logs = ensureLogObject(storage[BLOCK_LOGS_KEY]);
  const bucket = Array.isArray(logs[entryKey]) ? logs[entryKey] : [];
  const site = extractSiteFromUrl(blockedUrl);
  const now = new Date().toISOString();

  const existingIndex = bucket.findIndex((item) => item.site === site);
  if (existingIndex >= 0) {
    const existing = bucket[existingIndex];
    bucket[existingIndex] = {
      ...existing,
      sampleUrl: blockedUrl,
      count: Number(existing.count || 0) + 1,
      lastBlockedAt: now
    };
  } else {
    bucket.push({
      site,
      sampleUrl: blockedUrl,
      count: 1,
      lastBlockedAt: now
    });
  }

  bucket.sort((a, b) => String(b.lastBlockedAt).localeCompare(String(a.lastBlockedAt)));
  logs[entryKey] = bucket.slice(0, MAX_RECENT_BLOCKED_SITES);

  await chrome.storage.local.set({ [BLOCK_LOGS_KEY]: logs });
}

function ensureLogObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function extractSiteFromUrl(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

async function scheduleNextExpiry(entries) {
  if (expiryTimeoutId !== null) {
    clearTimeout(expiryTimeoutId);
    expiryTimeoutId = null;
  }

  const upcomingExpiries = entries
    .map((entry) => Date.parse(entry.expiresAt ?? ""))
    .filter((timestamp) => Number.isFinite(timestamp));

  if (upcomingExpiries.length === 0) {
    await chrome.alarms.clear(EXPIRY_ALARM_NAME);
    return;
  }

  const nextExpiry = Math.min(...upcomingExpiries);
  await chrome.alarms.create(EXPIRY_ALARM_NAME, { when: nextExpiry });

  // Best effort for short timers while worker is alive; alarms are the durable fallback.
  const delay = Math.max(0, nextExpiry - Date.now());
  const boundedDelay = Math.min(delay, 2_147_483_647);
  expiryTimeoutId = setTimeout(() => {
    syncRulesFromStorage().catch((error) => {
      console.error("Failed to sync rules on timer expiry", error);
    });
  }, boundedDelay);
}

chrome.runtime.onInstalled.addListener(() => {
  // Ensure first install starts from a consistent dynamic rule set.
  syncRulesFromStorage().catch((error) => {
    console.error("Failed to sync rules on install", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  syncRulesFromStorage().catch((error) => {
    console.error("Failed to sync rules on startup", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(BLOCKED_ENTRIES_KEY in changes)) {
    return;
  }

  syncRulesFromStorage().catch((error) => {
    console.error("Failed to sync rules after storage change", error);
  });
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((matchInfo) => {
    enqueueBlockedLog(matchInfo);
  });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== EXPIRY_ALARM_NAME) {
      return;
    }

    syncRulesFromStorage().catch((error) => {
      console.error("Failed to sync rules from alarm", error);
    });
  });
}
