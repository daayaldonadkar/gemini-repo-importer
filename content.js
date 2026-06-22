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
 *   STEP 3 (done):      Click "Import code" in the submenu.
 *   STEP 4 (done):      Paste the saved repository URL.
 *   STEP 5 (THIS FILE): Click the "Import" button.                        <-- implemented
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

// STEP 4 — the Import code dialog's repo-URL input field. The field's markup
// is now KNOWN: it carries data-test-id="repo-url-input" (an Angular Material
// outlined input). We lead with that exact selector; the rest of the list is a
// generic fallback in case Gemini ever drops the test id. findImportCodeInput
// also scans the dialog generically as a last resort.
const IMPORT_CODE_INPUT_SELECTORS = [
  '[data-test-id="repo-url-input"]', // confirmed — leads the list
  'input[type="url"]',
  'input[type="text"]',
  'input:not([type])',
  "textarea",
  '[contenteditable="true"]',
];
const INPUT_WAIT_MS = 3000; // wait up to 3s for the dialog/input to render
const INPUT_POLL_MS = 100; // re-check every 100ms

// Pause AFTER pasting the URL, BEFORE Step 5 clicks Import. Gemini resolves the
// repo asynchronously (a debounced GitHub lookup) once the field changes; if we
// click Import before that lookup finishes, Gemini rejects a perfectly good URL
// with "not a valid repo". 2s is a safe default for the network round-trip —
// bump it if imports still race the resolver.
const PASTE_SETTLE_MS = 2000;

// Angular's validity signal: a Material <input> carries the ng-valid class once
// its FormControl's validators pass (and ng-invalid while empty/failing). We
// gate each fill attempt on this — it's the authoritative "did Angular actually
// accept the value?" check, far stronger than "the DOM has text". Validators run
// synchronously on the value change, so this resolves within a tick or two.
const FIELD_VALID_WAIT_MS = 800; // per fill attempt, wait up to 800ms for ng-valid
const FIELD_VALID_POLL_MS = 50; // re-check every 50ms (sync validator = fast)

// STEP 5 — the "Import" button in the Import code dialog. It's an Angular
// Material button (hence the <span class="mat-mdc-button-touch-target"> marker),
// so we match by its "import" label rather than a generic class. We wait longer
// here than for menus because Angular keeps the button DISABLED until the pasted
// URL validates — findImportButton only returns buttons that are enabled.
const IMPORT_BUTTON_TEXT = "import"; // the button label we match (case-insensitive)
const IMPORT_BUTTON_WAIT_MS = 5000; // wait up to 5s for the button to enable
const IMPORT_BUTTON_POLL_MS = 150; // re-check every 150ms (Angular revalidates)

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
 * Steps 1–4 are implemented. The remaining step (Import) will be chained in
 * after this one is confirmed working on the real Gemini page.
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

  // --- STEP 4: paste the saved repo URL into the Import code input. ---
  console.log("Pasting repository URL");
  // pasteRepoUrl returns false if Angular never accepts the URL (field stays
  // ng-invalid); in that case the Import button is disabled, so skip Step 5
  // rather than click into a guaranteed failure.
  const pasted = await pasteRepoUrl(repoUrl);
  if (!pasted) {
    return;
  }

  // --- STEP 5: click the "Import" button to start the import. ---
  console.log("Clicking Import button");
  await clickImportButton(); // wait for the button to enable, then click
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
// 6. STEP 4 — paste the saved repository URL into the Import code input.
// ---------------------------------------------------------------------------
// After Step 3 clicks "Import code", a dialog opens containing a text field for
// the GitHub repo URL (data-test-id="repo-url-input"). We locate that field
// (inside the newest dialog/overlay) and fill it the way a USER does — not via a
// raw value assignment.
//
// WHY NOT just set el.value: a direct assignment (+ a synthetic input event) is
// enough for Angular to ENABLE the Import button (the format check passes), but
// Gemini ALSO runs an ASYNC GitHub lookup to resolve/verify the repo before
// import. That lookup keys off a real edit — a genuine paste or a real
// InputEvent — and a bare synthetic Event("input") doesn't trip it. The result:
// the button enables, the click fires, but the repo never resolved -> Gemini
// rejects a good URL with "not a valid repo". (This was the observed symptom.)
//
// So we fill the field in order of fidelity:
//   (1) dispatchPaste()        — a real ClipboardEvent("paste") carrying the URL.
//                                 Gemini may resolve the repo off the paste
//                                 event (the manual action that works).
//   (2) insertTextGenuinely()  — document.execCommand("insertText"), which
//                                 inserts AND fires a proper InputEvent the
//                                 framework treats like real typing.
//   (3) setInputValue()        — native value setter + input/change events;
//                                 a last resort.
// Synthetic events perform NO default insertion, so each step only counts if the
// field actually ends up holding the URL (checked via hasValue). Then we PAUSE
// (PASTE_SETTLE_MS) so the async resolver finishes before Step 5 clicks Import.

/**
 * True for text-like inputs we can drop a URL into: <textarea>, and <input> of
 * type "" / "text" / "url" / "search". Excludes checkbox/hidden/radio/etc.
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isTextInput(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  if (el.tagName === "TEXTAREA") {
    return true;
  }
  if (el.tagName === "INPUT") {
    const t = (el.type || "").toLowerCase();
    return t === "" || t === "text" || t === "url" || t === "search";
  }
  return false;
}

/**
 * The newest visible dialog/overlay on the page that contains an input — i.e.
 * the Import code dialog. Checks role="dialog", aria-modal="true", and
 * .cdk-overlay-pane, newest first (the Import code dialog opens AFTER the
 * submenu, so it's last in document order).
 *
 * @returns {Element|null}
 */
function newestDialog() {
  const candidates = [
    ...document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane'
    ),
  ];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (isVisible(c) && c.querySelector("input, textarea, [contenteditable]")) {
      return c;
    }
  }
  return null;
}

/**
 * Locate the Import code input field (pure query, no waiting). Searches the
 * newest dialog first (fast-path selectors, then any visible text input), then
 * the whole document as a fallback.
 *
 * @returns {Element|null}
 */
function findImportCodeInput() {
  const scope = newestDialog() || document;

  // Fast path: known / likely selectors for the URL field.
  for (const sel of IMPORT_CODE_INPUT_SELECTORS) {
    const el = scope.querySelector(sel);
    if (el && isVisible(el)) {
      return el;
    }
  }

  // Broader: any visible text-like input inside the scope.
  const inputs = [...scope.querySelectorAll("input, textarea")].filter(
    (el) => isVisible(el) && isTextInput(el)
  );
  return inputs[0] || null;
}

/**
 * Wait for the Import code input to appear (the dialog renders after Step 3).
 *
 * @returns {Promise<Element|null>}
 */
async function waitForImportCodeInput() {
  return waitFor(findImportCodeInput, INPUT_WAIT_MS, INPUT_POLL_MS);
}

/**
 * Angular's validity signal for a Material input. The <input> itself carries the
 * ng-valid class (when the FormControl's validators pass) or ng-invalid (when
 * they fail / the field is empty). This is the authoritative "did Angular
 * accept the value?" check — far stronger than "the DOM has text", because
 * Angular can hold a control invalid even when el.value already looks right.
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isFieldValid(el) {
  return !!(el && el.classList && el.classList.contains("ng-valid"));
}

/**
 * Poll until Angular marks `input` valid (ng-valid class appears), or timeout.
 * Material validators run synchronously on the value change, so this normally
 * resolves within a tick or two of a successful fill.
 *
 * @param {Element} input
 * @param {number} timeout
 * @returns {Promise<boolean>} true if the field became valid in time.
 */
async function waitForFieldValid(input, timeout) {
  const result = await waitFor(
    () => (isFieldValid(input) ? true : null),
    timeout,
    FIELD_VALID_POLL_MS
  );
  return !!result;
}

/**
 * Set `value` on an input/textarea and notify the framework (LAST-RESORT fill).
 *
 * Uses the NATIVE value setter (via the prototype descriptor) instead of a
 * direct `el.value = ...`, because Angular/React controlled inputs ignore a raw
 * assignment at the framework layer. Kept as the final fallback after
 * dispatchPaste() and insertTextGenuinely(), because it does NOT fire a proper
 * InputEvent — which is exactly why Gemini's async repo-resolver can miss it.
 *
 * @param {Element} el
 * @param {string} value
 */
function setInputValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : null;

  if (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  } else {
    // contenteditable or other — best-effort text replacement.
    el.textContent = value;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Dispatch a genuine "paste" event carrying `value` as text/plain (fill step 1).
 *
 * Pasting a URL is the MANUAL action that works, and Gemini may resolve/verify
 * the repo off the paste event specifically. We fire a real ClipboardEvent with
 * the URL in its clipboardData so any paste-bound handler sees it. A synthetic
 * paste performs NO default insertion, so the caller verifies the field was
 * filled (and falls back to insertTextGenuinely / setInputValue if not).
 *
 * Wrapped in try/catch: DataTransfer/ClipboardEvent construction can throw in
 * restricted contexts, and a failure here just means "try the next fill step".
 *
 * @param {Element} el
 * @param {string} value
 * @returns {boolean} true if the event dispatched without throwing.
 */
function dispatchPaste(el, value) {
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    const ev = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    el.dispatchEvent(ev);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Insert `value` via document.execCommand("insertText") (fill step 2).
 *
 * Unlike a raw value assignment, execCommand performs a genuine text insertion
 * that fires a proper InputEvent (inputType "insertText", carrying the text in
 * .data) — which Angular's value accessor and Gemini's input-bound validators
 * treat like real typing. This is the step most likely to trip the async
 * repo-resolver that a plain synthetic input event misses.
 *
 * We focus + select-all first so the insert REPLACES any existing content rather
 * than appending. execCommand is deprecated but still works in Chromium content
 * scripts and is the most framework-friendly way to programmatically fill an
 * input; if it's unavailable or reports failure we return false so the caller
 * falls back to setInputValue.
 *
 * @param {Element} el
 * @param {string} value
 * @returns {boolean} true if execCommand reported success.
 */
function insertTextGenuinely(el, value) {
  try {
    if (el.focus) {
      el.focus();
    }
    if (el.select) {
      el.select(); // select existing content so the insert replaces it
    } else if (el.setSelectionRange) {
      el.setSelectionRange(0, (el.value || "").length);
    }
  } catch (e) {
    /* best-effort focus/select */
  }
  try {
    return document.execCommand("insertText", false, value);
  } catch (e) {
    return false;
  }
}

/**
 * STEP 4 — paste the saved repo URL into the Import code input field.
 *
 * Fills the field like a user, in order of fidelity (paste event -> execCommand
 * insertText -> native setter). After EACH attempt we check Angular's validity
 * signal (ng-valid) to confirm Angular actually accepted the value — the DOM can
 * hold the URL while the FormControl stays ng-invalid, and submitting that state
 * is what produced "not a valid repo". The moment a method turns the field
 * ng-valid, we stop (no double-fill).
 *
 * Then we PAUSE (PASTE_SETTLE_MS) so Gemini's async repo-resolution can finish
 * before Step 5 clicks Import. See the section header for the full rationale.
 *
 * @param {string} repoUrl - the GitHub URL assigned to the shortcut.
 * @returns {Promise<boolean>} true if the URL was pasted, false if no input found
 *                              or Angular never accepted the value.
 */
async function pasteRepoUrl(repoUrl) {
  console.log("Waiting for Import code input");
  const input = await waitForImportCodeInput();
  if (!input) {
    console.log("[Gemini Repo Importer] Import code input not found");
    showToast("Import code input not found");
    return false;
  }

  console.log("Import code input found");
  if (input.focus) {
    input.focus();
  }

  // Try each fill method; stop as soon as Angular marks the field ng-valid.
  // waitForFieldValid is the gate that tells a real acceptance from a DOM-only
  // write, so we never proceed on a control that's secretly still invalid.
  const fillAttempts = [
    () => dispatchPaste(input, repoUrl),
    () => insertTextGenuinely(input, repoUrl),
    () => setInputValue(input, repoUrl),
  ];

  let accepted = false;
  for (const fill of fillAttempts) {
    fill();
    if (await waitForFieldValid(input, FIELD_VALID_WAIT_MS)) {
      accepted = true;
      break;
    }
  }

  if (!accepted) {
    // None of the fill methods made Angular accept the URL. The Import button
    // will stay disabled, so stop here with a clear message rather than click
    // into a guaranteed failure.
    console.log(
      "[Gemini Repo Importer] URL field never reached ng-valid after fill"
    );
    showToast("Could not fill repository URL");
    return false;
  }

  console.log(`Repository URL pasted: ${repoUrl}`);

  // Give Gemini's async repo-resolution (debounced GitHub lookup) time to run
  // BEFORE Step 5 clicks Import — otherwise the click races the resolver and
  // Gemini rejects a good URL as "not a valid repo".
  await sleep(PASTE_SETTLE_MS);
  showToast("Repository URL pasted");
  return true;
}

// ---------------------------------------------------------------------------
// 7. STEP 5 — click the "Import" button.
// ---------------------------------------------------------------------------
// After Step 4 fills the repo URL, the Import code dialog shows an "Import"
// button (an Angular Material button — the <span class="mat-mdc-button-touch-
// target"> marker the user pointed at). The button stays DISABLED until Angular
// validates the pasted URL, so we poll for an ENABLED button whose label is
// "Import" inside the newest dialog, then click it with the full pointer-event
// sequence (Material triggers can bind to mousedown, same as every other click).

/**
 * Is a button element currently clickable? Angular Material disables the Import
 * button until the URL validates — signalled by the native `disabled` attribute,
 * an `aria-disabled="true"` flag, or a disabled CSS class. Any of those means
 * "not yet", which is why findImportButton waits.
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isButtonEnabled(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  if (el.getAttribute("disabled") !== null) {
    return false;
  }
  if (el.getAttribute("aria-disabled") === "true") {
    return false;
  }
  // Material's disabled modifier classes (flat/raised/outlined/fab variants).
  if (
    el.classList.contains("mdc-button--disabled") ||
    el.classList.contains("mat-mdc-button-disabled") ||
    el.classList.contains("mdc-fab--disabled")
  ) {
    return false;
  }
  return true;
}

/**
 * Normalize an element's visible text for label matching: trimmed, collapsed
 * whitespace, lowercased. Gemini splits button labels across spans, so this
 * collapses them into a single comparable string.
 *
 * @param {Element} el
 * @returns {string}
 */
function buttonLabel(el) {
  return (el.textContent || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Locate the "Import" button (pure query, no waiting). Searches the newest
 * dialog first (the Import code dialog, same one holding the URL input), then
 * the whole document as a safety net. Prefers an EXACT "import" label so we
 * don't grab a "Cancel" button; falls back to a "contains import" match if the
 * exact label misses (e.g. an icon glyph appended to the label).
 *
 * Only considers candidates that are visible AND enabled, so a still-disabled
 * Import button is skipped and the poll continues.
 *
 * @returns {Element|null}
 */
function findImportButton() {
  const scope = newestDialog() || document;
  const raw = [
    ...scope.querySelectorAll(
      "button, [role='button'], a, .mat-mdc-button, .mat-mdc-unelevated-button, .mat-mdc-raised-button"
    ),
  ];
  // Dedupe first (keep the outermost of any nested candidates) then filter
  // visible + enabled — same shape as getMenuCandidates, plus enabled.
  const visible = raw.filter(isVisible);
  const clickable = visible
    .filter((el) => !visible.some((other) => other !== el && other.contains(el)))
    .filter(isButtonEnabled);

  // (1) Exact label match — the primary path.
  for (const el of clickable) {
    if (buttonLabel(el) === IMPORT_BUTTON_TEXT) {
      return el;
    }
  }
  // (2) "contains import" — looser fallback (still avoids disabled/hidden).
  for (const el of clickable) {
    if (buttonLabel(el).includes(IMPORT_BUTTON_TEXT)) {
      return el;
    }
  }
  return null;
}

/**
 * Wait for the "Import" button to appear AND become enabled. Angular enables it
 * only after the pasted URL validates — Step 4 set the value, but validation
 * runs on a later tick, so we poll up to IMPORT_BUTTON_WAIT_MS.
 *
 * @returns {Promise<Element|null>}
 */
async function waitForImportButton() {
  return waitFor(
    findImportButton,
    IMPORT_BUTTON_WAIT_MS,
    IMPORT_BUTTON_POLL_MS
  );
}

/**
 * STEP 5 — click the "Import" button in the Import code dialog.
 *
 * @returns {Promise<boolean>} true if the button was clicked, false otherwise.
 */
async function clickImportButton() {
  console.log("Waiting for Import button");
  const button = await waitForImportButton();
  if (!button) {
    console.log(
      "[Gemini Repo Importer] Import button not found or not enabled"
    );
    showToast("Import button not found");
    return false;
  }

  console.log("Import button found");
  clickMenuItem(button);
  console.log("Import clicked");
  showToast("Import started");
  return true;
}

// ---------------------------------------------------------------------------
// 8. TOAST UI — the temporary confirmation banner.
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
