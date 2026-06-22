# Gemini Repo Importer

A Manifest V3 Chrome extension scaffold. Eventually it will let you press
keyboard shortcuts (`Alt+Shift+1/2/3`) to import different GitHub repositories
into Gemini's **Import Code** feature.

> ⚠️ This is a scaffold only. **No import logic is implemented yet.** The
> command listener, content script, and popup are wired up as placeholders so
> the structure is ready for future work.

## Project structure

```
gemini-repo-importer/
├── manifest.json   # Extension config: permissions, site scope, commands, entry points
├── background.js   # Service worker — receives keyboard command events (the only place that can)
├── content.js      # Runs on gemini.google.com — will drive the Import Code DOM
├── popup.html      # Toolbar popup UI (static placeholder)
├── popup.js        # Popup behavior (placeholder; will read/write stored repo mappings)
└── icons/
    ├── icon16.png  # Toolbar icon
    ├── icon48.png  # Extensions-page icon
    └── icon128.png # Install/store icon
```

## What's configured

- **Permissions:** `storage`, `activeTab`, `scripting` (declared but not yet used).
- **Site scope:** restricted to `https://gemini.google.com/*` via
  `content_scripts.matches` and `host_permissions`.
- **Commands:** `repo1` → `Alt+Shift+1`, `repo2` → `Alt+Shift+2`,
  `repo3` → `Alt+Shift+3`. Each fires in `background.js`.

## How to load it (for testing the scaffolding)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `gemini-repo-importer` folder.
4. Press `Alt+Shift+1/2/3` — open the service worker's DevTools (click
   "service worker" on the extensions card) and you'll see the logged command.
