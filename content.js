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

// Candidate selector for items inside the submenu. Intentionally BROAD: Gemini
// may render each option as a role="menuitem", a <button>, a .mat-menu-item, or
// a link. We collect all of these, then de-dupe (see getMenuCandidates). Do NOT
// narrow this to role="menuitem" alone — that was the previous bug.
const MENU_ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], button, a, .mat-menu-item';

// How many times to retry the Import-code lookup after the submenu appears
// (items can render a moment after the pane), and the pause between retries.
const IMPORT_CODE_ATTEMPTS = 5;
const IMPORT_CODE_RETRY_MS = 150;

// Pause after a menu opens, before clicking inside it. Angular menus animate
// open (~200ms); clicking an item mid-animation can be swallowed — which was the
// "need to press the shortcut twice" symptom. Bump this if menus animate slower.
const MENU_SETTLE_MS = 250;

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

  // Open the uploads menu. We use the full pointer-event sequence (see
  // clickMenuItem) because Angular menu triggers often open on mousedown, which
  // a bare .click() never fires.
  clickMenuItem(uploadButton);
  console.log("Upload menu opened");
  // Let the uploads menu's open animation settle before we click inside it,
  // otherwise the "More uploads" click can land too early and be swallowed.
  await sleep(MENU_SETTLE_MS);

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
  clickMenuItem(button);
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
 * True when an element is actually painted on screen (worth clicking), as
 * opposed to merely present in the DOM. Menus sometimes keep hidden duplicates
 * in the DOM, so we filter on visibility before counting or picking items.
 *
 * @param {Element|null} el
 * @returns {boolean}
 */
function isVisible(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }
  let style = null;
  try {
    style = window.getComputedStyle(el);
  } catch (e) {
    style = null;
  }
  if (style) {
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
    if (parseFloat(style.opacity) === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Collect candidate menu items within `scope` as a clean list: matched by the
 * broad MENU_ITEM_SELECTOR, visible, and de-duplicated so a nested pair (e.g.
 * <li role="menuitem"><button>) counts ONCE (we keep the outermost).
 *
 * `scope` may be null/omitted to search the whole document.
 *
 * @param {Element|null} scope
 * @returns {Element[]}
 */
function getMenuCandidates(scope) {
  const root = scope || document;
  const visible = [...root.querySelectorAll(MENU_ITEM_SELECTOR)].filter(isVisible);
  // Keep only candidates NOT contained inside another candidate (the outermost),
  // so each visual row counts exactly once.
  return visible.filter(
    (el) => !visible.some((other) => other !== el && other.contains(el))
  );
}

/**
 * Wait for the submenu (opened by "More uploads") to appear and render at least
 * one item.
 *
 * The submenu is an Angular CDK overlay pane (`.cdk-overlay-pane`) or a
 * role="menu". We wait for the NEWEST visible one that already contains at least
 * one candidate item (broad selector — NOT just role="menuitem", since Gemini's
 * items may be plain buttons). Submenus append after their parent menu, so
 * "newest" reliably targets the one we just opened.
 *
 * Returns the submenu element, or null on timeout (callers must still attempt
 * the lookups regardless — a null here is not fatal).
 *
 * @returns {Promise<Element|null>}
 */
async function waitForSubmenu() {
  return waitFor(
    () => {
      const panes = [...document.querySelectorAll(".cdk-overlay-pane")];
      for (let i = panes.length - 1; i >= 0; i--) {
        if (isVisible(panes[i]) && getMenuCandidates(panes[i]).length > 0) {
          return panes[i];
        }
      }
      const menus = [...document.querySelectorAll('[role="menu"]')];
      for (let i = menus.length - 1; i >= 0; i--) {
        if (isVisible(menus[i]) && getMenuCandidates(menus[i]).length > 0) {
          return menus[i];
        }
      }
      return null;
    },
    OVERLAY_WAIT_MS,
    OVERLAY_POLL_MS
  );
}

/**
 * Locate the "Import code" item inside the submenu, by label text.
 *
 * Searches the candidate items (semantic, visible, de-duplicated) within `scope`
 * first; if nothing matches there, falls back to the whole document — the label
 * is specific enough that a document-wide match is safe even if the submenu pane
 * can't be identified.
 *
 * Whitespace is normalized before matching, so a label split across spans
 * ("Import" + "code") still hits. Case-insensitive.
 *
 * @param {Element|null} scope - submenu element, or null for the whole document.
 * @returns {Element|null}
 */
function findImportCodeItem(scope) {
  const needle = IMPORT_CODE_TEXT.toLowerCase().replace(/\s+/g, " ");
  const matchIn = (candidates) => {
    for (const el of candidates) {
      const text = (el.textContent || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (text.includes(needle)) {
        return el;
      }
    }
    return null;
  };
  // Submenu scope first, then the whole document as a safety net.
  return matchIn(getMenuCandidates(scope)) || matchIn(getMenuCandidates(null));
}

/**
 * Positional fallback: the Nth candidate item (0-based IMPORT_CODE_FALLBACK_INDEX)
 * inside the submenu `scope`. Per the known layout, "Import code" is the 3rd
 * item from the top (and 2nd from the bottom), i.e. index 2.
 *
 * Scoped to the submenu only — a document-wide positional pick is unreliable
 * when the parent menu is also open (its items would shift the index). Returns
 * null if there's no usable scope or too few items, so the caller can retry /
 * rely on the text lookup instead.
 *
 * @param {Element|null} scope
 * @returns {Element|null}
 */
function nthMenuItemFallback(scope) {
  if (!scope) {
    return null;
  }
  const items = getMenuCandidates(scope);
  return items.length > IMPORT_CODE_FALLBACK_INDEX
    ? items[IMPORT_CODE_FALLBACK_INDEX]
    : null;
}

/**
 * Scroll an element into view and "click" it with the FULL pointer-event
 * sequence: mouseover -> mousedown -> mouseup -> click.
 *
 * WHY NOT a bare .click(): a native .click() fires only the "click" event, but
 * Angular menu triggers ([matMenuTriggerFor]) commonly OPEN on "mousedown". A
 * bare click can therefore be silently ignored and the menu never opens — which
 * was the "press the shortcut twice" symptom. Dispatching the whole sequence
 * mimics a real tap and trips handlers bound to any of these events.
 *
 * Events bubble and are composed:true so they propagate like a real interaction
 * and cross any shadow-DOM boundary Gemini may use.
 *
 * @param {Element} el
 */
function clickMenuItem(el) {
  if (!el) {
    return;
  }
  if (el.scrollIntoView) {
    try {
      el.scrollIntoView({ block: "center" });
    } catch (e) {
      /* best-effort scroll */
    }
  }

  const opts = { bubbles: true, cancelable: true, view: window, composed: true };
  const fire = (type) => {
    try {
      el.dispatchEvent(new MouseEvent(type, opts));
    } catch (e) {
      // Fallback for engines without the MouseEvent constructor.
      try {
        const ev = document.createEvent("MouseEvents");
        ev.initMouseEvent(
          type,
          opts.bubbles,
          opts.cancelable,
          window,
          0, // detail
          0, 0, 0, 0, // screenX/Y, clientX/Y
          false, false, false, false, // ctrl/alt/shift/meta
          0, // button
          null // relatedTarget
        );
        el.dispatchEvent(ev);
      } catch (e2) {
        /* give up on this event type silently */
      }
    }
  };

  // hover -> press -> release -> click: the exact sequence a real tap produces.
  fire("mouseover");
  fire("mousedown");
  fire("mouseup");
  fire("click");
}

/**
 * STEP 3 — after "More uploads" opens the submenu, click the "Import code" item.
 *
 * Strategy, in priority order:
 *   1. Match the "Import code" label by text (most reliable; searches the
 *      submenu, then the whole document as a safety net).
 *   2. Fall back to the 3rd item by position (the known slot for Import code),
 *      scoped to the submenu.
 *
 * We wait for the submenu to render, then RETRY the lookups a few times — items
 * can appear a moment after the pane, and the submenu pane may not be detectable
 * at all (in which case the text lookup still works document-wide). A failure to
 * detect the overlay is NOT fatal: we always attempt the lookups.
 *
 * @returns {Promise<boolean>} true if an item was clicked, false otherwise.
 */
async function clickImportCode() {
  console.log("Waiting for Import code menu");
  const submenu = await waitForSubmenu(); // best-effort; null is OK
  if (submenu) {
    // Let the submenu's open animation settle before clicking inside it.
    await sleep(MENU_SETTLE_MS);
  }

  for (let attempt = 1; attempt <= IMPORT_CODE_ATTEMPTS; attempt++) {
    // (1) Text match — the primary path.
    const byText = findImportCodeItem(submenu);
    if (byText) {
      console.log("Import code item found");
      clickMenuItem(byText);
      console.log("Import code clicked");
      return true;
    }

    // (2) Positional fallback — Import code is the 3rd item from the top.
    const byPos = nthMenuItemFallback(submenu);
    if (byPos) {
      console.log(
        "[Gemini Repo Importer] 'Import code' text not found — clicking 3rd item (fallback)"
      );
      clickMenuItem(byPos);
      console.log("Import code clicked (fallback: 3rd item)");
      return true;
    }

    // Not ready yet — pause and retry.
    if (attempt < IMPORT_CODE_ATTEMPTS) {
      await sleep(IMPORT_CODE_RETRY_MS);
    }
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
