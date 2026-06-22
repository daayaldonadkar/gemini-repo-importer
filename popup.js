/*
 * popup.js — Behavior for the configuration popup (popup.html).
 *
 * RESPONSIBILITIES:
 *   1. On open: read saved mappings from chrome.storage.sync and fill the inputs.
 *   2. Validate as the user types (empty allowed; otherwise must start with
 *      https://github.com/) and disable Save while anything is invalid.
 *   3. On Save: write the mappings back to chrome.storage.sync.
 *
 * STORAGE FORMAT (the object we read/write under the STORAGE_KEY):
 *   { "repos": { "1": "https://github.com/org/repo", "2": "...", ... } }
 *   Empty shortcuts are OMITTED so storage only holds assigned repos.
 */

// --- Constants -------------------------------------------------------------
const STORAGE_KEY = "repos"; // top-level key in chrome.storage.sync
const REPO_PREFIX = "https://github.com/"; // every non-empty URL must start here
const SHORTCUT_COUNT = 9; // UI shows Shortcut 1 .. Shortcut 9

// --- Element handles -------------------------------------------------------
const fieldsEl = document.getElementById("fields");
const errorEl = document.getElementById("error");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

// --- Build the 9 input rows ------------------------------------------------
// Keep a map: shortcut number -> input element, for fast access later.
const inputs = {};
for (let n = 1; n <= SHORTCUT_COUNT; n++) {
  const row = document.createElement("div");
  row.className = "row";

  const label = document.createElement("label");
  label.textContent = `Shortcut ${n}`;

  const input = document.createElement("input");
  input.type = "url";
  input.dataset.shortcut = String(n);
  input.placeholder = REPO_PREFIX + "org/repo";
  // Re-validate on every keystroke so the Save button + error stay live.
  input.addEventListener("input", validate);

  row.append(label, input);
  fieldsEl.append(row);
  inputs[n] = input;
}

// --- On load: populate fields from storage ---------------------------------
(async function init() {
  // chrome.storage.sync.get returns an object keyed by what we requested.
  // Default to {} if nothing has ever been saved.
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  const repos = data[STORAGE_KEY] || {};
  for (let n = 1; n <= SHORTCUT_COUNT; n++) {
    inputs[n].value = repos[String(n)] || "";
  }
  // Run validation once so the button state matches what we just loaded.
  validate();
})();

// --- Validation ------------------------------------------------------------
// Returns true when every field is valid. As a side effect it updates the
// error message and toggles the Save button's disabled state.
function validate() {
  const errors = [];
  for (let n = 1; n <= SHORTCUT_COUNT; n++) {
    const value = inputs[n].value.trim();
    if (value === "") continue; // empty is explicitly allowed
    if (!value.startsWith(REPO_PREFIX)) {
      errors.push(`Shortcut ${n} must start with ${REPO_PREFIX}`);
    }
  }

  if (errors.length > 0) {
    // Show a combined, human-readable error and block saving.
    errorEl.hidden = false;
    errorEl.textContent = errors.join("  •  ");
    saveBtn.disabled = true;
    return false;
  }

  // Everything valid: clear the error and re-enable Save.
  errorEl.hidden = true;
  errorEl.textContent = "";
  saveBtn.disabled = false;
  return true;
}

// --- Save ------------------------------------------------------------------
saveBtn.addEventListener("click", async () => {
  // Defensive: never save while invalid (button is disabled, but be sure).
  if (saveBtn.disabled) return;

  // Assemble the { "1": url, "2": url, ... } object, omitting empty fields
  // so a cleared shortcut is effectively deleted from storage.
  const repos = {};
  for (let n = 1; n <= SHORTCUT_COUNT; n++) {
    const value = inputs[n].value.trim();
    if (value !== "") {
      repos[String(n)] = value;
    }
  }

  // Persist to chrome.storage.sync (syncs to the user's Google account).
  await chrome.storage.sync.set({ [STORAGE_KEY]: repos });

  // Brief "Saved" confirmation so the user gets feedback it worked.
  statusEl.hidden = false;
  statusEl.textContent = "Saved";
  setTimeout(() => {
    statusEl.hidden = true;
  }, 1500);
});
