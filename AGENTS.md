# Repository Guidelines

## Project Structure

This repository is a Chrome Manifest V3 extension that syncs X bookmarks into an Obsidian vault. `manifest.json` defines the extension. Browser-facing code, popup and manager pages, styles, storage, and file-system integration live in `extension/`. Shared, browser-independent logic lives in `src/` (for example `core.js`, `manager-core.js`, `x-api-parser.js`, `library-sync.js`, and `sync-core.js`). Node tests are in `tests/`. There is no separate build output directory; load the repository root as an unpacked extension.

## Development and Tests

- `npm test` runs all tests with Node's built-in test runner (`node --test`).
- To try UI changes, open `chrome://extensions`, enable Developer mode, and load this repository as an unpacked extension. Reload it after editing extension files.
- No build, formatter, or linter scripts are currently configured. Keep changes compatible with the existing native ES module setup (`"type": "module"`).

## Code Style and Naming

Use JavaScript ES modules and two-space indentation, matching the existing files. Prefer `camelCase` for functions and variables, descriptive names for exported helpers, and hyphenated lowercase filenames (for example, `manager-core.js`). Keep reusable data transformations in `src/`; keep Chrome APIs and DOM interactions in `extension/`. Avoid adding dependencies for functionality available in the browser or Node runtime.

## Testing Guidelines

Add or update tests under `tests/` for changes to shared logic. Name files `*.test.js` and use `node:test` with `node:assert/strict`. Cover expected behavior and edge cases such as missing tweet fields, duplicate IDs, and category fallbacks. Run `npm test` before submitting changes. UI behavior that depends on Chrome should also be checked manually in the extension.

## Commits and Pull Requests

Git history is not available in this checkout, so no established commit convention can be confirmed. Use short, imperative commit subjects that describe one change, such as `Refresh indexed bookmark metadata`. Pull requests should explain the user-visible change, note relevant testing (including manual browser checks), link related issues when available, and include screenshots for popup or manager UI changes. Keep changes focused and update `README.md` when user instructions or supported behavior changes.

## Security and Configuration

Do not commit vault contents, personal bookmark exports, credentials, or local browser data. Keep extension permissions in `manifest.json` limited to those required for bookmark collection and user-selected vault access.
