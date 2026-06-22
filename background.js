/*
 * background.js — Service worker (Manifest V3 background script)
 *
 * ROLE OF THIS FILE:
 * The service worker is the ONLY component that receives keyboard command
 * events. On each shortcut it:
 *   1. Identifies the repo number (repo1/repo2/repo3 -> 1/2/3).
 *   2. Finds the active tab.
 *   3. Only proceeds if that tab is a Gemini page.
 *   4. Reads the saved mapping from chrome.storage.sync.
 *   5. Sends the content script either:
 *        - { action: "repoSelected", repoNumber, repoUrl }  when a URL exists
 *        - { action: "repoMissing",  repoNumber }            when none exists
 *
 * STORAGE FORMAT under chrome.storage.sync key "repos":
 *   { "1": "https://github.com/org/repo", "2": "...", ... }
 */

chrome.commands.onCommand.addListener(async (command) => {
  // STEP 1 — Convert command name to a repo number ("repo1" -> 1).
  const match = /^repo(\d+)$/.exec(command);
  if (!match) {
    return; // Unknown command — ignore.
  }
  const repoNumber = Number(match[1]);

  // STEP 2 — Get the currently active tab in the focused window.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return; // No active tab — nothing to do.
  }

  // STEP 3 — Only act on Gemini pages (host_permissions lets us read this URL).
  if (!tab.url || !tab.url.startsWith("https://gemini.google.com/")) {
    return; // Not Gemini — ignore the shortcut.
  }

  // STEP 4 — Look up the saved repository URL for this shortcut.
  const data = await chrome.storage.sync.get("repos");
  const repos = data.repos || {};
  const repoUrl = repos[String(repoNumber)]; // undefined / "" -> treated as missing

  // STEP 5 — Notify the content script, choosing the message by availability.
  try {
    if (!repoUrl) {
      // No mapping saved for this shortcut.
      await chrome.tabs.sendMessage(tab.id, {
        action: "repoMissing",
        repoNumber: repoNumber,
      });
    } else {
      // A mapping exists — pass the URL along for later automation.
      await chrome.tabs.sendMessage(tab.id, {
        action: "repoSelected",
        repoNumber: repoNumber,
        repoUrl: repoUrl,
      });
    }
  } catch (error) {
    // Usually means content.js isn't injected yet (Gemini tab predates the
    // extension). Ask the user to reload that tab.
    console.log(
      `[Gemini Repo Importer] Could not reach the Gemini tab (try reloading it): ${error.message}`
    );
  }
});
