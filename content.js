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
 *   STEP 2 (done):      Click "More uploads".
 *   STEP 3 (THIS FILE): Click "Import code" in the submenu.               <-- implemented
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

// STEP 3 — "Import code" lives inside the Angular CDK overlay submenu that
// opens after "More uploads" is clicked. We wait for that overlay to render,
// then locate the item by its label text (with a positional fallback).
const IMPORT_CODE_TEXT = "Import code"; // label we match (case-insensitive)
const IMPORT_CODE_FALLBACK_INDEX = 2; // 0-based -> the 3rd menu item, if text misses
const OVERLAY_WAIT_MS = 3000; // wait up to 3s for the submenu to render
const OVERLAY_POLL_MS = 100; // re-check every 100ms (dynamic render)

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
 * React to a "repoSelected" message: open the uploads menu (Step 1), open
 * "More uploads" (Step 2), then click "Import code" in the submenu (Step 3),
 * then STOP.
 *
 * Steps 1–3 are implemented. The remaining steps (paste URL → Import) will be
 * chained in after this one is confirmed working on the real Gemini page.
 *
 * Async because Steps 2–3 poll for dynamically-rendered menu items.
 *
 * @param {number} repoNumber - which shortcut was pressed (1/2/3).
 * @param {string} repoUrl - the GitHub URL assigned to that shortcut.
 */
async function handleRepoSelected(repoNumber, repoUrl) {
  // Step 0 — make sure the DOM is ready to query before we touch it. Resolves
  // instantly in the normal (user-triggered) case; a safety net otherwise.
  await waitForPageReady();

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

  // --- STEP 3: open the submenu and click "Import code". ---
  console.log("Waiting for Import code menu");
  await clickImportCode(); // wait for CDK overlay, find by text (or 3rd-item fallback), click

  // STEP 3 ENDS HERE. Do NOT proceed to paste URL / Import yet — those are
  // future steps, each to be added in its own function.
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
// 5. STEP 3 — open the submenu and click "Import code".
// ---------------------------------------------------------------------------
// "Import code" lives in an Angular CDK overlay submenu that opens AFTER Step 2
// clicks "More uploads". That submenu renders asynchronously, so we:
//   (a) wait for the overlay (a `.cdk-overlay-pane` / role="menu") to appear and
//       contain at least one menuitem,
//   (b) find the "Import code" item by label text and click it,
//   (c) fall back to the 3rd menu item if the text lookup misses (e.g. a
//       localized or renamed label).
//
// The first two helpers below (waitForPageReady, waitFor) are generic timing
// utilities; the rest are Step-3-specific.

/**
 * Resolve once the DOM is ready to query (readyState "interactive" or better).
 *
 * We gate on "interactive" (not strictly "complete") on purpose: some SPAs keep
 * readyState at "interactive" indefinitely while long-loading sub-resources
 * never finish, and waiting for "complete" would hang forever in that case. The
 * composer + menus are manipulable as soon as the DOM is interactive. In the
 * normal user-triggered case the page is already complete, so this is instant.
 *
 * @returns {Promise<void>}
 */
function waitForPageReady() {
  return new Promise((resolve) => {
    const ready = () =>
      document.readyState === "interactive" ||
      document.readyState === "complete";
    if (ready()) {
      return resolve();
    }
    const onChange = () => {
      if (ready()) {
        document.removeEventListener("readystatechange", onChange);
        resolve();
      }
    };
    document.addEventListener("readystatechange", onChange);
  });
}

/**
 * Poll `predicate` until it returns a truthy value, or `timeout` ms elapse.
 * Each call is wrapped so a throwing predicate degrades to "not yet" instead of
 * killing the loop. Returns the predicate's truthy result, or null on timeout.
 *
 * @param {() => any} predicate
 * @param {number} timeout
 * @param {number} interval
 * @returns {Promise<any>}
 */
async function waitFor(predicate, timeout, interval) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let result = null;
    try {
      result = predicate();
    } catch (e) {
      result = null;
    }
    if (result) {
      return result;
    }
    await sleep(interval);
  }
  return null;
}

/**
 * Wait for the Angular CDK overlay submenu to appear after "More uploads" is
 * clicked.
 *
 * Angular CDK renders pop-up menus into a `.cdk-overlay-pane` (inside a
 * `cdk-overlay-container` appended to <body>) and gives the menu role="menu"
 * with role="menuitem" children. We wait until such a pane exists AND contains
 * at least one menuitem — proof the submenu has actually rendered its items, not
 * just an empty shell. (There may be more than one pane if the parent menu is
 * still open; any pane with menuitems is good enough to proceed.)
 *
 * Returns the overlay pane (or a role="menu" fallback), or null on timeout.
 *
 * @returns {Promise<Element|null>}
 */
async function waitForOverlayMenu() {
  return waitFor(
    () => {
      // Preferred: an overlay pane that already has rendered menu items.
      const panes = document.querySelectorAll(".cdk-overlay-pane");
      for (const pane of panes) {
        if (pane.querySelector('[role="menuitem"]')) {
          return pane;
        }
      }
      // Fallback: any element with role="menu" that has menu items.
      const menus = document.querySelectorAll('[role="menu"]');
      for (const menu of menus) {
        if (menu.querySelector('[role="menuitem"]')) {
          return menu;
        }
      }
      return null;
    },
    OVERLAY_WAIT_MS,
    OVERLAY_POLL_MS
  );
}

/**
 * Locate the "Import code" menu item inside the open overlay submenu, by text.
 *
 * We prefer semantic menu items / buttons / links (their textContent is just the
 * label, so a substring match is reliable); only as a last resort do we scan
 * generic LEAF elements (div/span with no children) so a wrapper that merely
 * *contains* the label can't be clicked by mistake. The match is
 * case-insensitive ("import code", "Import Code", etc. all hit).
 *
 * @returns {Element|null}
 */
function findImportCodeItem() {
  const needle = IMPORT_CODE_TEXT.toLowerCase();
  const semantic = document.querySelectorAll(
    '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], button, a'
  );
  for (const el of semantic) {
    if (el.textContent && el.textContent.trim().toLowerCase().includes(needle)) {
      return el;
    }
  }
  // Last resort: a leaf element (no children) bearing the label text.
  for (const el of document.querySelectorAll("div, span")) {
    if (
      el.children.length === 0 &&
      el.textContent &&
      el.textContent.trim().toLowerCase().includes(needle)
    ) {
      return el;
    }
  }
  return null;
}

/**
 * Fallback click target: the Nth (0-based IMPORT_CODE_FALLBACK_INDEX) menu item
 * in the most-recently-opened overlay pane. Submenus are appended AFTER their
 * parent menu, so the last pane-with-items is the submenu we just opened. Used
 * when the text lookup fails (e.g. a localized or renamed label).
 *
 * Falls back to the Nth menuitem anywhere in the document if no overlay pane has
 * enough items.
 *
 * @returns {Element|null}
 */
function nthMenuItemFallback() {
  const panes = [...document.querySelectorAll(".cdk-overlay-pane")];
  for (let i = panes.length - 1; i >= 0; i--) {
    const items = panes[i].querySelectorAll('[role="menuitem"]');
    if (items.length > IMPORT_CODE_FALLBACK_INDEX) {
      return items[IMPORT_CODE_FALLBACK_INDEX];
    }
  }
  const all = document.querySelectorAll('[role="menuitem"]');
  return all[IMPORT_CODE_FALLBACK_INDEX] || null;
}

/**
 * STEP 3 — after "More uploads" opens the submenu, click the "Import code" item.
 *
 * Flow: wait for the Angular CDK overlay to render, then locate "Import code" by
 * text and click it. If the text lookup fails (e.g. the label is localized or
 * changed), fall back to clicking the 3rd menu item in the submenu.
 *
 * @returns {Promise<boolean>} true if an item was clicked, false otherwise.
 */
async function clickImportCode() {
  // (a) Wait for the overlay submenu to render its items.
  const menu = await waitForOverlayMenu();
  if (!menu) {
    console.log("[Gemini Repo Importer] Import code menu (overlay) not found");
    showToast("Import code menu not found");
    return false;
  }

  // (b) Find the "Import code" item by text.
  const item = findImportCodeItem();
  if (item) {
    console.log("Import code item found");
    // Bring it on-screen before clicking (some overlays render off-viewport).
    if (item.scrollIntoView) {
      item.scrollIntoView({ block: "center" });
    }
    item.click();
    console.log("Import code clicked");
    return true;
  }

  // (c) Text lookup failed — fall back to the 3rd menu item.
  console.log(
    "[Gemini Repo Importer] 'Import code' text not found — using 3rd-item fallback"
  );
  const fallback = nthMenuItemFallback();
  if (fallback) {
    if (fallback.scrollIntoView) {
      fallback.scrollIntoView({ block: "center" });
    }
    fallback.click();
    console.log("Import code clicked (fallback)");
    return true;
  }

  console.log("[Gemini Repo Importer] Import code item not found");
  showToast("Import code item not found");
  return false;
}

// ---------------------------------------------------------------------------
// 6. TOAST UI — the temporary confirmation banner.
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
