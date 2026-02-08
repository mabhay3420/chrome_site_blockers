import {
  BLOCKED_ENTRIES_KEY,
  BLOCK_LOGS_KEY,
  ENTRY_TYPES,
  MASTER_PIN_HASH_KEY,
  entryKeyFromEntry,
  filterActiveEntries,
  normalizeDomain,
  normalizeEntries
} from "./src/rule-builder.js";

const PRESET_DURATION_MS = {
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
};

const CUSTOM_UNIT_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000
};

const MASTER_PIN_LENGTH = 6;
const EMERGENCY_MASTER_PIN = "456789";

/**
 * Curated defaults for common distracting sites (incl. programmer-heavy contexts).
 */
const SUGGESTED_SITES = [
  { domain: "x.com", label: "Social", aliases: ["twitter"] },
  { domain: "instagram.com", label: "Social", aliases: ["insta", "ig"] },
  { domain: "youtube.com", label: "Video", aliases: ["yt"] },
  { domain: "reddit.com", label: "Social", aliases: [] },
  { domain: "facebook.com", label: "Social", aliases: ["fb"] },
  { domain: "tiktok.com", label: "Video", aliases: [] },
  { domain: "linkedin.com", label: "Social", aliases: [] },
  { domain: "discord.com", label: "Chat", aliases: [] },
  { domain: "twitch.tv", label: "Streaming", aliases: [] },
  { domain: "netflix.com", label: "Streaming", aliases: [] },
  { domain: "primevideo.com", label: "Streaming", aliases: ["amazon prime"] },
  { domain: "pinterest.com", label: "Social", aliases: [] },
  { domain: "news.ycombinator.com", label: "Programmer", aliases: ["hackernews", "hn"] },
  { domain: "github.com", label: "Programmer", aliases: ["gh"] },
  { domain: "stackoverflow.com", label: "Programmer", aliases: ["so"] },
  { domain: "dev.to", label: "Programmer", aliases: ["devto"] },
  { domain: "medium.com", label: "Reading", aliases: [] },
  { domain: "producthunt.com", label: "Programmer", aliases: ["ph"] },
  { domain: "indiehackers.com", label: "Programmer", aliases: ["ih"] },
  { domain: "lobste.rs", label: "Programmer", aliases: ["lobsters"] }
];

const form = document.getElementById("block-form");
const typeSelect = document.getElementById("entry-type");
const valueInput = document.getElementById("entry-value");
const suggestionsEl = document.getElementById("entry-suggestions");
const durationTemplateButtons = Array.from(
  document.querySelectorAll("button[data-duration-template]")
);
const customDurationRow = document.getElementById("custom-duration-row");
const customDurationValueInput = document.getElementById("custom-duration-value");
const customDurationUnitSelect = document.getElementById("custom-duration-unit");
const requiresMasterPinCheckbox = document.getElementById("requires-master-pin");
const messageEl = document.getElementById("message");
const entryListEl = document.getElementById("entry-list");
const entryDetailsEl = document.getElementById("entry-details");

const settingsToggleButton = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const settingsCloseButton = document.getElementById("settings-close");
const settingsHelperEl = document.getElementById("settings-helper");
const settingsMessageEl = document.getElementById("settings-message");
const newPinLabel = document.getElementById("new-pin-label");
const saveMasterPinButton = document.getElementById("save-master-pin");

const pinModal = document.getElementById("pin-modal");
const pinModalMessageEl = document.getElementById("pin-modal-message");
const pinCancelButton = document.getElementById("pin-cancel");
const pinConfirmButton = document.getElementById("pin-confirm");

let currentSuggestions = [];
let activeSuggestionIndex = -1;
let hideSuggestionsTimeoutId = null;
let selectedDurationTemplate = "indefinite";
let hasMasterPin = false;
let pendingRemovalIndex = -1;
let expandedEntryKey = null;

const newPinOtp = createOtpInputGroup(document.getElementById("new-pin-inputs"), "new");
const removePinOtp = createOtpInputGroup(document.getElementById("remove-pin-inputs"), "remove");

/**
 * Read entries + per-rule logs from storage and return normalized data.
 */
async function getStoredState() {
  const storage = await chrome.storage.local.get([BLOCKED_ENTRIES_KEY, BLOCK_LOGS_KEY]);
  const normalizedEntries = normalizeEntries(storage[BLOCKED_ENTRIES_KEY]);
  const activeEntries = filterActiveEntries(normalizedEntries);

  // If some entries expired while popup was closed, prune them now.
  if (activeEntries.length !== normalizedEntries.length) {
    await saveEntries(activeEntries);
  }

  const logs = storage[BLOCK_LOGS_KEY] ?? {};
  const activeKeys = new Set(activeEntries.map((entry) => entryKeyFromEntry(entry)));
  const prunedLogs = Object.fromEntries(
    Object.entries(logs).filter(([entryKey]) => activeKeys.has(entryKey))
  );

  if (Object.keys(prunedLogs).length !== Object.keys(logs).length) {
    await chrome.storage.local.set({ [BLOCK_LOGS_KEY]: prunedLogs });
  }

  return {
    entries: activeEntries,
    logs: prunedLogs
  };
}

/**
 * Save entries back to storage. Background worker listens to this and re-syncs DNR rules.
 */
async function saveEntries(entries) {
  await chrome.storage.local.set({
    [BLOCKED_ENTRIES_KEY]: normalizeEntries(entries)
  });
}

async function getMasterPinHash() {
  const storage = await chrome.storage.local.get(MASTER_PIN_HASH_KEY);
  return typeof storage[MASTER_PIN_HASH_KEY] === "string" ? storage[MASTER_PIN_HASH_KEY] : "";
}

async function setMasterPin(pin) {
  const nextHash = await hashPin(pin);
  await chrome.storage.local.set({ [MASTER_PIN_HASH_KEY]: nextHash });
}

async function verifyMasterPin(pin) {
  if (!isValidSixDigitPin(pin)) {
    return false;
  }

  const currentHash = await getMasterPinHash();
  if (!currentHash) {
    return false;
  }

  const candidateHash = await hashPin(pin);
  return candidateHash === currentHash;
}

async function hashPin(pin) {
  const payload = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isValidSixDigitPin(pin) {
  return /^\d{6}$/.test(pin);
}

function setMessage(text, kind = "ok") {
  messageEl.textContent = text;
  messageEl.className = `message message--${kind}`;
}

function setInlineMessage(target, text, kind = "ok") {
  target.textContent = text;
  target.className = `message message--inline message--${kind}`;
}

function clearInlineMessage(target) {
  target.textContent = "";
  target.className = "message message--inline";
}

function renderEntries(entries, logsByEntryKey) {
  entryListEl.innerHTML = "";
  entryDetailsEl.innerHTML = "";
  entryDetailsEl.hidden = true;

  if (entries.length === 0) {
    expandedEntryKey = null;
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No rules yet.";
    entryListEl.appendChild(empty);
    return;
  }

  if (!entries.some((entry) => entryKeyFromEntry(entry) === expandedEntryKey)) {
    expandedEntryKey = null;
  }

  entries.forEach((entry) => {
    const itemEntryKey = entryKeyFromEntry(entry);
    const isExpanded = expandedEntryKey === itemEntryKey;

    const chipItem = document.createElement("li");
    chipItem.className = "entry-chip-item";

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `entry-chip${isExpanded ? " is-active" : ""}`;
    chip.dataset.role = "toggle";
    chip.dataset.entryKey = itemEntryKey;
    chip.setAttribute("aria-pressed", String(isExpanded));
    chip.setAttribute("title", entry.value);

    const chipValue = document.createElement("code");
    chipValue.className = "entry-chip__value";
    chipValue.textContent = entry.value;
    chip.appendChild(chipValue);

    const badges = document.createElement("span");
    badges.className = "entry-chip__badges";

    if (entry.expiresAt) {
      const timedBadge = document.createElement("span");
      timedBadge.className = "entry-chip__badge entry-chip__badge--timed";
      timedBadge.textContent = "Timed";
      badges.appendChild(timedBadge);
    }

    if (entry.requiresMasterPin) {
      const pinBadge = document.createElement("span");
      pinBadge.className = "entry-chip__badge entry-chip__badge--pin";
      pinBadge.textContent = "PIN";
      badges.appendChild(pinBadge);
    }

    if (badges.childElementCount > 0) {
      chip.appendChild(badges);
    }

    chipItem.appendChild(chip);
    entryListEl.appendChild(chipItem);
  });

  if (!expandedEntryKey) {
    return;
  }

  const expandedIndex = entries.findIndex((entry) => entryKeyFromEntry(entry) === expandedEntryKey);
  if (expandedIndex < 0) {
    return;
  }

  renderEntryDetails(entries[expandedIndex], expandedIndex, logsByEntryKey);
}

function renderEntryDetails(entry, index, logsByEntryKey) {
  const panel = document.createElement("article");
  panel.className = "entry-details__panel";

  const title = document.createElement("code");
  title.className = "entry-details__title";
  title.textContent = entry.value;

  const details = document.createElement("div");
  details.className = "entry-item__details";

  const meta = document.createElement("div");
  meta.className = "entry-item__meta";

  const type = document.createElement("span");
  type.className = "entry-item__type";
  type.textContent = `Type: ${entry.type}`;

  const security = document.createElement("span");
  security.className = "entry-item__security";
  security.textContent = entry.requiresMasterPin ? "Removal: PIN protected" : "Removal: open";

  const expiry = document.createElement("span");
  expiry.className = "entry-item__expiry";
  expiry.textContent = formatExpiryLabel(entry);

  meta.append(type, security, expiry);

  const logBucket = Array.isArray(logsByEntryKey[entryKeyFromEntry(entry)])
    ? logsByEntryKey[entryKeyFromEntry(entry)]
    : [];

  const blockedSites = document.createElement("ul");
  blockedSites.className = "entry-item__logs";

  if (logBucket.length === 0) {
    const emptyLog = document.createElement("li");
    emptyLog.className = "entry-item__log entry-item__log--empty";
    emptyLog.textContent = "No blocked hits yet.";
    blockedSites.appendChild(emptyLog);
  } else {
    logBucket.forEach((hit) => {
      const hitItem = document.createElement("li");
      hitItem.className = "entry-item__log";

      const site = document.createElement("code");
      site.className = "entry-item__log-site";
      site.textContent = hit.site;

      const count = document.createElement("span");
      count.className = "entry-item__log-count";
      count.textContent = `${hit.count}x`;

      hitItem.append(site, count);
      blockedSites.appendChild(hitItem);
    });
  }

  meta.appendChild(blockedSites);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "entry-item__remove";
  removeButton.textContent = "Remove";
  removeButton.dataset.index = String(index);
  removeButton.dataset.protected = entry.requiresMasterPin ? "true" : "false";
  removeButton.dataset.role = "remove";

  details.append(meta, removeButton);
  panel.append(title, details);
  entryDetailsEl.hidden = false;
  entryDetailsEl.appendChild(panel);
}

function formatExpiryLabel(entry) {
  if (!entry.expiresAt) {
    return "Duration: Indefinite";
  }

  const remainingMs = Date.parse(entry.expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return "Duration: Expired";
  }

  if (remainingMs < 60 * 1000) {
    return `Duration: ${Math.ceil(remainingMs / 1000)}s left`;
  }

  if (remainingMs < 60 * 60 * 1000) {
    return `Duration: ${Math.ceil(remainingMs / (60 * 1000))}m left`;
  }

  if (remainingMs < 24 * 60 * 60 * 1000) {
    return `Duration: ${Math.ceil(remainingMs / (60 * 60 * 1000))}h left`;
  }

  return `Duration: ${Math.ceil(remainingMs / (24 * 60 * 60 * 1000))}d left`;
}

function buildEntryFromForm() {
  const type = typeSelect.value;
  const value = valueInput.value.trim();

  if (!value) {
    return { error: "Value is required." };
  }

  const duration = buildDurationFromForm();
  if (duration.error) {
    return { error: duration.error };
  }

  const requiresMasterPin = Boolean(requiresMasterPinCheckbox.checked);

  if (type === ENTRY_TYPES.DOMAIN) {
    const domain = normalizeDomain(value);
    if (!domain) {
      return { error: "Enter a valid domain, e.g. example.com" };
    }

    const entry = { type: ENTRY_TYPES.DOMAIN, value: domain };
    return { entry: applyOptionalFields(entry, duration.expiresAt, requiresMasterPin) };
  }

  const patternEntry = { type: ENTRY_TYPES.PATTERN, value };
  return { entry: applyOptionalFields(patternEntry, duration.expiresAt, requiresMasterPin) };
}

function applyOptionalFields(baseEntry, expiresAt, requiresMasterPin) {
  let nextEntry = { ...baseEntry };

  if (expiresAt) {
    nextEntry = { ...nextEntry, expiresAt };
  }

  if (requiresMasterPin) {
    nextEntry = { ...nextEntry, requiresMasterPin: true };
  }

  return nextEntry;
}

function getDurationSortValue(expiresAt) {
  if (!expiresAt) {
    return Number.POSITIVE_INFINITY;
  }

  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function keepLongestDurationEntry(existingEntry, incomingEntry) {
  const existingDuration = getDurationSortValue(existingEntry.expiresAt);
  const incomingDuration = getDurationSortValue(incomingEntry.expiresAt);
  const longestDuration = Math.max(existingDuration, incomingDuration);

  const merged = {
    type: incomingEntry.type,
    value: incomingEntry.value
  };

  if (Number.isFinite(longestDuration) && longestDuration > 0) {
    merged.expiresAt = new Date(longestDuration).toISOString();
  }

  if (existingEntry.requiresMasterPin || incomingEntry.requiresMasterPin) {
    merged.requiresMasterPin = true;
  }

  return merged;
}

function buildDurationFromForm() {
  const preset = selectedDurationTemplate;

  if (preset === "indefinite") {
    return { expiresAt: null };
  }

  if (preset in PRESET_DURATION_MS) {
    return {
      expiresAt: new Date(Date.now() + PRESET_DURATION_MS[preset]).toISOString()
    };
  }

  if (preset === "custom") {
    const amount = Number(customDurationValueInput.value);
    const unit = customDurationUnitSelect.value;
    const unitMs = CUSTOM_UNIT_MS[unit];

    if (!Number.isInteger(amount) || amount <= 0) {
      return { error: "Custom duration must be a positive whole number." };
    }

    if (!unitMs) {
      return { error: "Choose a valid custom duration unit." };
    }

    return {
      expiresAt: new Date(Date.now() + amount * unitMs).toISOString()
    };
  }

  return { error: "Choose a valid duration option." };
}

function applyDurationTemplate(preset) {
  selectedDurationTemplate = preset;

  durationTemplateButtons.forEach((button) => {
    const isActive = button.dataset.durationTemplate === preset;
    button.classList.toggle("duration-template--active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  customDurationRow.hidden = preset !== "custom";
}

function normalizeLookupValue(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function scoreCandidate(query, candidate) {
  if (!query || !candidate) {
    return -1;
  }

  if (candidate === query) {
    return 1000;
  }

  if (candidate.startsWith(query)) {
    return 900 - Math.max(0, candidate.length - query.length);
  }

  const bareCandidate = candidate.split(".")[0];
  if (bareCandidate.startsWith(query)) {
    return 860 - Math.max(0, bareCandidate.length - query.length);
  }

  const containsIndex = candidate.indexOf(query);
  if (containsIndex >= 0) {
    return 700 - containsIndex;
  }

  let currentPos = -1;
  let gapPenalty = 0;

  for (const character of query) {
    const nextPos = candidate.indexOf(character, currentPos + 1);
    if (nextPos < 0) {
      return -1;
    }
    gapPenalty += nextPos - currentPos - 1;
    currentPos = nextPos;
  }

  return 500 - gapPenalty;
}

function getSuggestionMatches(rawQuery, limit = 6) {
  const query = normalizeLookupValue(rawQuery);
  if (!query || typeSelect.value !== ENTRY_TYPES.DOMAIN) {
    return [];
  }

  return SUGGESTED_SITES.map((site) => {
    const scoreCandidates = [site.domain, ...(site.aliases ?? [])].map((candidate) =>
      scoreCandidate(query, normalizeLookupValue(candidate))
    );

    return {
      ...site,
      score: Math.max(...scoreCandidates)
    };
  })
    .filter((site) => site.score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.domain.localeCompare(right.domain);
    })
    .slice(0, limit);
}

function hideSuggestions() {
  currentSuggestions = [];
  activeSuggestionIndex = -1;
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
}

function selectSuggestionAt(index) {
  if (index < 0 || index >= currentSuggestions.length) {
    return;
  }

  valueInput.value = currentSuggestions[index].domain;
  hideSuggestions();
}

function renderSuggestions() {
  suggestionsEl.innerHTML = "";

  if (currentSuggestions.length === 0) {
    suggestionsEl.hidden = true;
    return;
  }

  currentSuggestions.forEach((suggestion, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "suggestion-item";
    if (index === activeSuggestionIndex) {
      option.classList.add("suggestion-item--active");
    }
    option.dataset.index = String(index);

    const domain = document.createElement("code");
    domain.className = "suggestion-item__domain";
    domain.textContent = suggestion.domain;

    const meta = document.createElement("span");
    meta.className = "suggestion-item__meta";
    meta.textContent = suggestion.label;

    option.append(domain, meta);
    suggestionsEl.appendChild(option);
  });

  suggestionsEl.hidden = false;
}

function refreshSuggestions() {
  const matches = getSuggestionMatches(valueInput.value);
  currentSuggestions = matches;
  activeSuggestionIndex = matches.length > 0 ? 0 : -1;
  renderSuggestions();
}

function createOtpInputGroup(container, idPrefix) {
  const inputs = [];

  for (let index = 0; index < MASTER_PIN_LENGTH; index += 1) {
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.maxLength = 1;
    input.className = "otp-input";
    input.id = `${idPrefix}-pin-${index}`;
    input.autocomplete = "one-time-code";

    input.addEventListener("input", () => {
      const digit = input.value.replace(/\D/g, "").slice(0, 1);
      input.value = digit;
      if (digit && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        inputs[index - 1].focus();
      }

      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        inputs[index - 1].focus();
      }

      if (event.key === "ArrowRight" && index < inputs.length - 1) {
        event.preventDefault();
        inputs[index + 1].focus();
      }
    });

    inputs.push(input);
    container.appendChild(input);
  }

  container.addEventListener("paste", (event) => {
    event.preventDefault();
    const digits = (event.clipboardData?.getData("text") || "").replace(/\D/g, "").slice(0, 6);
    inputs.forEach((input, index) => {
      input.value = digits[index] ?? "";
    });

    const focusIndex = Math.min(digits.length, MASTER_PIN_LENGTH - 1);
    inputs[Math.max(0, focusIndex)].focus();
  });

  return {
    getValue() {
      return inputs.map((input) => input.value).join("");
    },
    clear() {
      inputs.forEach((input) => {
        input.value = "";
      });
    },
    focusFirst() {
      inputs[0]?.focus();
    }
  };
}

async function refreshList() {
  const { entries, logs } = await getStoredState();
  renderEntries(entries, logs);
}

async function refreshSecurityState() {
  const currentHash = await getMasterPinHash();
  hasMasterPin = Boolean(currentHash);

  newPinLabel.textContent = hasMasterPin ? "Reset PIN" : "Set PIN";
  settingsHelperEl.textContent = hasMasterPin
    ? "You can reset your 6-digit PIN directly at any time."
    : "No PIN set yet. Create a new 6-digit PIN.";
}

async function removeEntryAtIndex(index) {
  const { entries } = await getStoredState();
  if (index < 0 || index >= entries.length) {
    return;
  }

  entries.splice(index, 1);
  await saveEntries(entries);
  setMessage("Rule removed.", "ok");
  await refreshList();
}

function openPinModalForIndex(index) {
  pendingRemovalIndex = index;
  removePinOtp.clear();
  clearInlineMessage(pinModalMessageEl);
  pinModal.hidden = false;
  removePinOtp.focusFirst();
}

function closePinModal() {
  pinModal.hidden = true;
  pendingRemovalIndex = -1;
  removePinOtp.clear();
  clearInlineMessage(pinModalMessageEl);
}

async function handleRemoveButton(removeButton) {
  const index = Number(removeButton.dataset.index);
  if (!Number.isInteger(index)) {
    return;
  }

  const isProtected = removeButton.dataset.protected === "true";
  if (isProtected) {
    openPinModalForIndex(index);
    return;
  }

  await removeEntryAtIndex(index);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("");

  const { entry, error } = buildEntryFromForm();
  if (error) {
    setMessage(error, "error");
    return;
  }

  if (entry.requiresMasterPin) {
    const latestHash = await getMasterPinHash();
    if (!latestHash) {
      setMessage("Set a master PIN in Settings before enabling protected removal.", "error");
      return;
    }
  }

  const { entries } = await getStoredState();
  const entryKey = entryKeyFromEntry(entry);
  const existingIndex = entries.findIndex((item) => entryKeyFromEntry(item) === entryKey);

  const nextEntries = [...entries];
  let message = "Rule added.";

  if (existingIndex >= 0) {
    nextEntries[existingIndex] = keepLongestDurationEntry(entries[existingIndex], entry);
    message = "Rule updated.";
  } else {
    nextEntries.push(entry);
  }

  await saveEntries(nextEntries);
  valueInput.value = "";
  requiresMasterPinCheckbox.checked = false;
  hideSuggestions();
  setMessage(message, "ok");
  await refreshList();
});

entryListEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const actionButton = target.closest("button[data-role]");
  if (!(actionButton instanceof HTMLButtonElement)) {
    return;
  }

  const role = actionButton.dataset.role;
  if (role !== "toggle") {
    return;
  }

  const entryKey = actionButton.dataset.entryKey ?? "";
  if (!entryKey) {
    return;
  }

  expandedEntryKey = expandedEntryKey === entryKey ? null : entryKey;
  await refreshList();
});

entryDetailsEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const actionButton = target.closest("button[data-role]");
  if (!(actionButton instanceof HTMLButtonElement)) {
    return;
  }

  const role = actionButton.dataset.role;
  if (role === "toggle") {
    const entryKey = actionButton.dataset.entryKey ?? "";
    if (!entryKey) {
      return;
    }

    expandedEntryKey = expandedEntryKey === entryKey ? null : entryKey;
    await refreshList();
    return;
  }

  if (role !== "remove") {
    return;
  }

  await handleRemoveButton(actionButton);
});

pinCancelButton.addEventListener("click", () => {
  closePinModal();
});

pinConfirmButton.addEventListener("click", async () => {
  if (pendingRemovalIndex < 0) {
    closePinModal();
    return;
  }

  const pin = removePinOtp.getValue();
  if (!isValidSixDigitPin(pin)) {
    setInlineMessage(pinModalMessageEl, "PIN must be 6 digits.", "error");
    return;
  }

  const matchesMaster = await verifyMasterPin(pin);
  const matchesEmergency = pin === EMERGENCY_MASTER_PIN;

  if (!matchesMaster && !matchesEmergency) {
    setInlineMessage(pinModalMessageEl, "Incorrect PIN. Use 456789 only if you forgot your PIN.", "error");
    return;
  }

  const removeIndex = pendingRemovalIndex;
  closePinModal();
  await removeEntryAtIndex(removeIndex);
});

settingsToggleButton.addEventListener("click", async () => {
  const nextState = settingsPanel.hidden;
  settingsPanel.hidden = !nextState;
  clearInlineMessage(settingsMessageEl);

  if (nextState) {
    await refreshSecurityState();
    newPinOtp.focusFirst();
  }
});

settingsCloseButton.addEventListener("click", () => {
  settingsPanel.hidden = true;
  clearInlineMessage(settingsMessageEl);
});

saveMasterPinButton.addEventListener("click", async () => {
  clearInlineMessage(settingsMessageEl);
  const newPin = newPinOtp.getValue();

  if (!isValidSixDigitPin(newPin)) {
    setInlineMessage(settingsMessageEl, "New PIN must be exactly 6 digits.", "error");
    return;
  }

  await setMasterPin(newPin);
  newPinOtp.clear();
  await refreshSecurityState();
  setInlineMessage(settingsMessageEl, "Master PIN saved.", "ok");
});

suggestionsEl.addEventListener("mousedown", (event) => {
  // Prevent input blur before click handlers can read selected suggestion.
  event.preventDefault();
});

suggestionsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const option = target.closest("button.suggestion-item");
  if (!option) {
    return;
  }

  const index = Number(option.dataset.index);
  if (!Number.isInteger(index)) {
    return;
  }

  selectSuggestionAt(index);
});

valueInput.addEventListener("focus", () => {
  if (hideSuggestionsTimeoutId !== null) {
    clearTimeout(hideSuggestionsTimeoutId);
    hideSuggestionsTimeoutId = null;
  }

  refreshSuggestions();
});

valueInput.addEventListener("blur", () => {
  hideSuggestionsTimeoutId = setTimeout(() => {
    hideSuggestions();
    hideSuggestionsTimeoutId = null;
  }, 100);
});

valueInput.addEventListener("input", () => {
  refreshSuggestions();
});

valueInput.addEventListener("keydown", (event) => {
  if (currentSuggestions.length === 0) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
    renderSuggestions();
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    activeSuggestionIndex =
      (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
    renderSuggestions();
    return;
  }

  if (event.key === "Enter" && activeSuggestionIndex >= 0) {
    event.preventDefault();
    selectSuggestionAt(activeSuggestionIndex);
    return;
  }

  if (event.key === "Tab" && !event.shiftKey) {
    event.preventDefault();
    const nextIndex = activeSuggestionIndex >= 0 ? activeSuggestionIndex : 0;
    selectSuggestionAt(nextIndex);
    return;
  }

  if (event.key === "Escape") {
    hideSuggestions();
  }
});

typeSelect.addEventListener("change", () => {
  if (typeSelect.value !== ENTRY_TYPES.DOMAIN) {
    hideSuggestions();
  } else {
    refreshSuggestions();
  }
});

durationTemplateButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const preset = button.dataset.durationTemplate;
    if (!preset) {
      return;
    }

    applyDurationTemplate(preset);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (BLOCKED_ENTRIES_KEY in changes || BLOCK_LOGS_KEY in changes) {
    refreshList().catch((error) => {
      console.error("Failed to refresh popup list after storage update", error);
    });
  }

  if (MASTER_PIN_HASH_KEY in changes) {
    refreshSecurityState().catch((error) => {
      console.error("Failed to refresh security state", error);
    });
  }
});

applyDurationTemplate(selectedDurationTemplate);
refreshSecurityState().catch((error) => {
  console.error("Failed to initialize security state", error);
});

refreshList().catch((error) => {
  console.error("Failed to load popup list", error);
  setMessage("Failed to load rules.", "error");
});
