/*
 * content.js — Content script (runs only on https://gemini.google.com/*)
 *
 * ROLE OF THIS FILE:
 * Receives messages from the background service worker and drives Gemini's UI
 * on the page to import a GitHub repository.
 *
 * AUTOMATION PROGRESS (built up one isolated step at a time):
 *   STEP 1 (done):      Click the composer's "Upload and tools" (+) button to
 *                        open the uploads menu.
 *   STEP 2 (THIS FILE): Click "More uploads".                             <-- implemented
 *   STEP 3 (future):    Click "Import code".
 *   STEP 4 (future):    Paste the saved repository URL.
 *   STEP 5 (future):    Click "Import".
 *
 * Each step lives in its OWN function so later prompts can slot the next step
 * in without rewriting what already works.
 *
 * MESSAGE TYPES received from background.js:
 *   - "repoSelected": a repo URL is assigned to the shortcut -> run automation.
 *   - "repoMissing":  no repo is assigned -> show a "No repository assigned"
 *                     toast and stop.
 */

// ---------------------------------------------------------------------------
// 0. TUNABLE CONSTANTS
// ---------------------------------------------------------------------------
// The composer DOM is now KNOWN, so we hard-code the exact selectors instead of
// guessing with generic text/attribute scans (the old "Add"/"Attach"/"Plus"
// approach is gone). If Gemini ever changes its markup, these two lines are the
// only thing to update — no hunting through logic.
//
// Kept as named constants (not inlined) so a future DOM change is a one-line
// edit, and so the finders below read as plain English.

// The composer: the chat text-input area at the bottom of the page.
const COMPOSER_SELECTOR = ".text-input-field.simplified-input-area";

// The "+" button that opens the uploads / tools menu.
const UPLOAD_BUTTON_SELECTOR = 'button[aria-label="Upload and tools"]';

// STEP 2 — the "More uploads" button, which appears INSIDE the uploads menu
// after Step 1 opens it.
const MORE_UPLOADS_BUTTON_SELECTOR = "button.more-upload-button";

// The uploads menu renders its items dynamically after Step 1's click, so we
// POLL for the "More uploads" button instead of querying once. Bounded so a
// genuinely-missing button fails fast (~3s) instead of hanging forever.
const MORE_UPLOADS_WAIT_MS = 3000; // wait up to 3 seconds for the menu item
const MORE_UPLOADS_POLL_MS = 100; // re-check every 100ms (dynamic render)

// ---------------------------------------------------------------------------
// 1. MESSAGE HANDLER — entry point; reacts to the background script.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false; // Ignore empty messages.
  }

  // CASE A — a repository URL is assigned to this shortcut: run the automation.
  if (message.action === "repoSelected") {
    const repoNumber = message.repoNumber;
    const repoUrl = message.repoUrl;

    // Fire-and-forget: background.js never reads our response, so we do NOT keep
    // the message channel open (returning false closes it immediately). The work
    // proceeds in the background.
    handleRepoSelected(repoNumber, repoUrl);
    return false;
  }

  // CASE B — no repository is assigned to this shortcut: just inform the user.
  if (message.action === "repoMissing") {
    const repoNumber = message.repoNumber;
    showToast(`No repository assigned to Shortcut ${repoNumber}`);
    return false;
  }

  // Any other action is not ours — ignore.
  return false;
});

// ---------------------------------------------------------------------------
// 2. ORCHESTRATOR — runs the automation steps.
// ---------------------------------------------------------------------------
/**
 * React to a "repoSelected" message: open the uploads menu (Step 1), then open
 * the next level via "More uploads" (Step 2), then STOP.
 *
 * Steps 1 and 2 are implemented. The remaining steps (Import code → paste URL →
 * Import) will be chained in after this one is confirmed working on the real
 * Gemini page.
 *
 * Async because Step 2 polls for a dynamically-rendered menu item.
 *
 * @param {number} repoNumber - which shortcut was pressed (1/2/3).
 * @param {string} repoUrl - the GitHub URL assigned to that shortcut.
 */
async function handleRepoSelected(repoNumber, repoUrl) {
  // One tidy debug block per trigger, in the page's DevTools console.
  console.log("[Gemini Repo Importer]");
  console.log(`Shortcut: ${repoNumber}`);
  console.log(`Repo: ${repoUrl}`);

  // --- STEP 1: find composer + click "Upload and tools" to open the menu. ---
  const composer = findComposer();
  const uploadButton = findUploadButton(composer);

  // No composer -> we're not on a page state we can drive. Stop here.
  if (!composer) {
    console.log("[Gemini Repo Importer] Composer not found");
    showToast("Gemini composer not found");
    return;
  }
  console.log("Composer found");

  // Composer present but the + button isn't -> the markup has changed. Stop.
  if (!uploadButton) {
    console.log("[Gemini Repo Importer] Upload button not found");
    showToast("Upload button not found");
    return;
  }
  console.log("Upload and tools button found");

  // Open the uploads menu. A native .click() dispatches a real click event that
  // bubbles to Gemini's React handlers; nothing fancier is needed here.
  uploadButton.click();
  console.log("Upload menu opened");

  // --- STEP 2: wait for the menu to render, then click "More uploads". ---
  console.log("Waiting for More uploads");
  await waitForMoreUploadsButton(); // poll for the dynamically-rendered item
  await clickMoreUploads(); // one-shot find + click

  // STEP 2 ENDS HERE. Do NOT proceed to Import code / paste / Import yet —
  // those are future steps, each to be added in its own function.
}

// ---------------------------------------------------------------------------
// 3. STEP 1 LOCATORS — find the composer and the "Upload and tools" button.
// ---------------------------------------------------------------------------
// Both finders are PURE synchronous queries using the known selectors above —
// no generic button sweeps, no "Add"/"Attach"/"Plus" text matching. Keeping
// them pure (no waiting, no retry) makes the orchestrator's flow trivial to
// follow: find, check, click.

/**
 * Find Gemini's composer (the chat text-input area).
 *
 * @returns {Element|null} the composer element, or null if it isn't on the page.
 */
function findComposer() {
  return document.querySelector(COMPOSER_SELECTOR);
}

/**
 * Find the "Upload and tools" (+) button.
 *
 * We look INSIDE the composer first (passing `composer` scopes the query and
 * confirms the button belongs to the composer we found), then fall back to the
 * whole document in case the button is a sibling of the input rather than a
 * descendant. Both paths use the exact known selector — no guessing.
 *
 * `composer` may be null (the orchestrator queries the button before it has
 * checked the composer); this function tolerates that and simply searches the
 * document instead.
 *
 * @param {Element|null} composer - the composer element (scoped search root),
 *        or null to search the whole document.
 * @returns {Element|null} the upload button, or null if not found.
 */
function findUploadButton(composer) {
  // Scoped query first: faster, and ties the button to the composer we found.
  if (composer && composer.querySelector) {
    const scoped = composer.querySelector(UPLOAD_BUTTON_SELECTOR);
    if (scoped) {
      return scoped;
    }
  }
  // Fallback: the button may live outside the input element (e.g. a sibling in
  // the composer's toolbar row).
  return document.querySelector(UPLOAD_BUTTON_SELECTOR);
}

// ---------------------------------------------------------------------------
// 4. STEP 2 — open "More uploads" (wait for it, then click).
// ---------------------------------------------------------------------------
// Step 2 has two cooperating functions, mirroring the spec's flow:
//   - waitForMoreUploadsButton(): poll until the button exists. The uploads
//     menu renders its items dynamically, so the button isn't there the instant
//     Step 1 clicks the + button.
//   - clickMoreUploads():         a one-shot find + click, run once the button
//     is known to exist. Kept defensive (re-query + null check) in case the
//     menu closes between the wait and the click.

/**
 * Promise-based delay. Used to pace the polling loop below.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the "More uploads" button to appear inside the uploads menu.
 *
 * The uploads menu builds its items dynamically AFTER the "Upload and tools"
 * button is clicked, so the "More uploads" button usually isn't in the DOM the
 * instant we look. This polls for it — up to MORE_UPLOADS_WAIT_MS, checking
 * every MORE_UPLOADS_POLL_MS — and resolves as soon as it appears.
 *
 * We do NOT click here; this function only confirms the button has rendered.
 * The click happens in clickMoreUploads(), so waiting and clicking stay
 * isolated and individually testable.
 *
 * @returns {Promise<Element|null>} the button once it appears, or null on timeout.
 */
async function waitForMoreUploadsButton() {
  const deadline = Date.now() + MORE_UPLOADS_WAIT_MS;
  while (Date.now() < deadline) {
    const button = document.querySelector(MORE_UPLOADS_BUTTON_SELECTOR);
    if (button) {
      return button;
    }
    await sleep(MORE_UPLOADS_POLL_MS);
  }
  return null;
}

/**
 * Find and click the "More uploads" button (one-shot query).
 *
 * This is a single query, not a poll: the orchestrator calls
 * waitForMoreUploadsButton() first so the button is already rendered by the
 * time we get here. We still re-query and null-check defensively, in case the
 * menu closed between the wait and the click.
 *
 * @returns {Promise<boolean>} true if the button was clicked, false if missing.
 */
async function clickMoreUploads() {
  const button = document.querySelector(MORE_UPLOADS_BUTTON_SELECTOR);

  if (!button) {
    showToast("More uploads button not found");
    return false;
  }

  console.log("More uploads button found");
  button.click();
  console.log("More uploads clicked");
  return true;
}

// ---------------------------------------------------------------------------
// 5. TOAST UI — the temporary confirmation banner.
// ---------------------------------------------------------------------------

/**
 * Lazily create (once) and return the fixed container pinned to the top-right
 * corner. A single shared container means rapid repeated triggers STACK
 * neatly instead of overlapping.
 */
function getToastContainer() {
  let container = document.getElementById("__gri_toast_container");
  if (container) {
    return container;
  }

  container = document.createElement("div");
  container.id = "__gri_toast_container";

  // Pin to the viewport top-right; extreme z-index keeps it above Gemini's UI;
  // pointer-events:none so the banner never eats clicks meant for the page.
  Object.assign(container.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    display: "flex",
    flexDirection: "column", // stack multiple toasts top-to-bottom
    gap: "8px",
    pointerEvents: "none",
  });

  (document.body || document.documentElement).appendChild(container);
  return container;
}

/**
 * Show a short-lived toast with the given text.
 * - Top-right corner (via the shared container).
 * - Auto-removes after 2 seconds.
 * - Safe to call repeatedly: each call makes its own element + own timer.
 */
function showToast(text) {
  const container = getToastContainer();

  const toast = document.createElement("div");
  toast.textContent = text;

  // Inline styles keep the toast self-contained and resilient to Gemini's CSS.
  Object.assign(toast.style, {
    background: "#1f1f1f",
    color: "#ffffff",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "14px",
    lineHeight: "1.4",
    padding: "10px 14px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
    maxWidth: "260px",
    pointerEvents: "none",
  });

  container.appendChild(toast);

  // Auto-disappear after exactly 2 seconds. Per-toast timer => each banner
  // cleans itself up independently; triggering again just adds another.
  setTimeout(() => {
    toast.remove();
  }, 2000);
}
