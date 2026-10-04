# ChatGPTBox Architecture and Agent Guide

Use this file as the starting point for changes in this repository. It records the runtime
boundaries and project-specific workflows that are easy to miss from a directory listing.

## 1. Project Overview

ChatGPTBox is a client-only, cross-browser extension that injects AI chat, page/selection tools,
and site-specific integrations into web pages. There is no repository-owned application server.
The extension talks directly to configured AI providers or their web applications and persists
user settings and conversation history through extension storage.

The UI uses Preact with React compatibility, JSX, and SCSS. Browser APIs are normally accessed
through `webextension-polyfill`. Webpack 5 builds separate Chromium Manifest V3 and Firefox
Manifest V2 packages; Safari is converted from the Firefox package.

### Runtime boundaries

| Context | Entry point | Responsibility |
| --- | --- | --- |
| Content script | `src/content-script/index.jsx` | Inject chat/selection UI, run the active site adapter, read page state, and exchange messages with the extension. |
| Background | `src/background/index.mjs` | Own privileged browser APIs, provider dispatch, cross-context routing, cookies, context menus, commands, and guarded network requests. It is an MV3 service worker on Chromium and a persistent MV2 background script on Firefox. |
| Popup/options | `src/popup/index.jsx` | Render settings and provider configuration; the same page is used for the toolbar popup and options UI. |
| Independent panel | `src/pages/IndependentPanel/index.jsx` | Host the standalone conversation page, popup window, and Chromium side panel. |
| Video-summary offscreen document | `src/pages/VideoSummaryOffscreen/index.mjs` | Run the long-lived Bilibili transcription/summary task in the full Chromium build without placing provider credentials in page code. |

### Main application flow

- `FloatingToolbar` and conversation components create a serializable session and communicate over
  extension ports. `src/services/wrappers.mjs` normalizes session/model state, handles cancellation
  and stale requests, and reports translated errors.
- Background selects the configured implementation under `src/services/apis/`. OpenAI-compatible
  providers are normalized through `provider-registry.mjs`; web-account modes may proxy work to a
  provider page where its content script has the required authenticated context.
- `src/content-script/site-adapters/index.mjs` is the site registry. Generic search integrations
  provide DOM selectors; richer adapters expose an `init` action. Selection tools and context-menu
  tools are separate registries under `src/content-script/selection-tools/` and `menu-tools/`.
- Shared conversation state is defined by `src/services/init-session.mjs` and stored by
  `src/services/local-session.mjs`. Common UI belongs in `src/components/`; browser-independent
  helpers belong in `src/utils/`.

### Bilibili video-summary pipeline

This branch contains a second, explicitly gated pipeline in addition to the legacy subtitle prompt:

1. `site-adapters/bilibili/video-page-bridge.mjs` reads the current Bilibili SSR/API state, native
   subtitles, and HTTPS DASH audio candidates, and owns local timestamp seeking.
2. `video-summary-host.mjs` renders `BilibiliVideoSummaryView` and sends structured-clone-safe task
   commands through a named port. No DOM object, callback, signal, or secret crosses that boundary.
3. `background/video-summary-router.mjs` derives ownership from the port sender as
   `(tabId, documentId, videoId)`, routes task events, and provides a reattachment grace period.
4. The Chromium offscreen runtime owns `video-summary/task-runner.mjs`, checkpoints, cancellation,
   and the media pipeline. Native subtitles enter the summarizer directly. ASR first asks Volcengine
   AI MediaKit to fetch the remote candidate; documented fetch failures may fall back to a
   task-scoped OPFS download and signed upload, followed by cleanup.
5. Background-only `MediaKitGateway` and `ModelGateway` read credentials and make provider calls.
   The runner chunks transcripts, invokes structured tools for chunk summaries and final synthesis,
   and builds a deterministic result with transcript coverage and failed ranges.

The enhanced pipeline is enabled only when the build flag, user setting, MV3/offscreen capability,
and Chromium 116+ runtime checks pass. `VideoSummaryOffscreen.*` is copied only into the full
Chromium output. Firefox, Safari, minimal builds, unsupported pages, and disabled settings retain
the existing subtitle-summary path. The design record is
`docs/superpowers/specs/2026-09-27-video-transcription-summary-design.md`; prefer running code when
the document and implementation differ.

### Architectural change map

- Add or change a site integration in `src/content-script/site-adapters/` and register it in that
  directory's `index.mjs`. Keep page DOM and player knowledge inside the adapter boundary.
- Add or change an API/provider under `src/services/apis/`; keep provider selection and endpoint/key
  resolution aligned with `src/config/`, `provider-registry.mjs`, and model-name migrations.
- Add reusable UI under `src/components/`; entry-point-specific composition stays in content,
  popup, or page directories.
- Treat `src/video-summary/` as browser-context-neutral task/domain code. Privileged secrets and
  remote calls stay behind the background gateways; page extraction stays in the Bilibili adapter.
- Ask before deleting/renaming files, changing manifests/build configuration, or making a change
  that affects multiple adapters unless the current request explicitly authorizes it.

## 2. Build and Commands

Node 22 or newer is required (`.nvmrc` contains `22`; `package.json` declares `>=22`). Install the
locked dependency graph with `npm ci`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Webpack development build in watch mode with external source maps and injected CSS. Stop it cleanly before branch/dependency/config switches. |
| `BUILD_WATCH_ONCE=1 npm run dev` | Produce one development build and exit; useful for CI or diagnostics. |
| `npm run build` | Production build and zip all Chromium/Firefox full and minimal variants. Allow up to 5–10 minutes; do not kill during bundling. |
| `npm run analyze` | Production-mode bundle analysis. |
| `npm run pretty` / `npm run pretty:check` | Format or check JS, MJS, JSX, JSON, CSS, and SCSS. Markdown is not included. |
| `npm run lint` / `npm run lint:fix` | ESLint source, tests, scripts, and workflow scripts. |
| `npm test` | Run the Node test suite with the browser shim. |
| `npm run test:coverage` | Run tests under c8 and write text, lcov, and JSON-summary coverage. |
| `npm run verify` | Fetch live search-engine pages and validate adapter parsing. Network, anti-bot, or markup failures are not build failures unless search adapters are the task. |
| `npm run build:safari` | On macOS with Xcode, build all variants, convert the Firefox extension, archive/export the app, and create `build/safari.dmg`. |
| `npm run release:firefox-sources` | Create the AMO source archive and review instructions. |
| `npm run release:submit:dry-run` | Validate built store artifacts and release credentials without uploading. |\n| `npm run release:submit` | Upload prepared artifacts to extension stores; run only as an explicitly authorized release operation with all required credentials. |

Production outputs are:

- `build/chromium/` and `build/firefox/`
- `build/chromium-without-katex-and-tiktoken/` and
  `build/firefox-without-katex-and-tiktoken/`
- one zip beside each directory; Safari additionally produces an app bundle and `build/safari.dmg`

For a Chromium artifact sanity check, expect `manifest.json`, `background.js`,
`content-script.{js,css}`, `popup.{html,js,css}`, `IndependentPanel.{html,js}`, `shared.js`,
`logo.png`, and `rules.json`. The full Chromium package also contains
`VideoSummaryOffscreen.{html,js}`.

GitHub Actions run `pretty:check` and lint separately, and run `test:coverage` plus the production
build for runtime changes. Tagged releases build Chromium, Firefox, Safari, and the Firefox source
archive before store submission. Real store publication depends on repository secrets and belongs
in the tagged-release workflow; do not invoke it casually from a development shell.

### Build tuning

`build.mjs` supports these environment variables:

- `BUILD_PARALLEL=0` serializes the two production bundles; parallel is the default.
- `BUILD_THREAD=0` disables Babel `thread-loader`; `BUILD_THREAD_WORKERS=<n>` caps worker count.
- `BUILD_POOL_TIMEOUT=<ms>` changes the production thread-pool timeout (default `2000`).
- `BUILD_CACHE_COMPRESSION=0|false|none|gzip|brotli` controls Webpack cache compression; default is
  no compression.
- `BUILD_RESOLVE_SYMLINKS=1` re-enables symlink resolution for linked/workspace dependencies.

If dependencies or caches are suspect, reinstall with `npm ci` and remove only the generated
`build/`, `dist/`, or dependency cache paths needed for the diagnosis. Never discard unrelated
working-tree changes.

## 3. Code Style

- Prettier is authoritative: 100-column width, two-space indentation, single quotes, no semicolons,
  trailing commas, and bracket spacing.
- Source is ES modules. Use `.mjs` for non-JSX modules and `.jsx` for components/JSX entry points.
- Reusable component directories use PascalCase; feature and adapter directories use kebab-case;
  package-style entry modules are normally `index.mjs` or `index.jsx`.
- Use Preact APIs/compatibility rather than introducing a separate React runtime. Use
  `webextension-polyfill` for cross-browser APIs and explicitly guard Chromium-only APIs.
- Preserve structured-clone-safe message contracts. Validate messages at context boundaries and
  derive privileged identity (tab/document) from browser-provided sender metadata.
- Keep network/provider logic auditable in `src/services/apis/` or a narrow background gateway.
  Avoid new heavy dependencies because every production variant pays the bundle cost.
- Run `npm run pretty` before `npm run lint`. The pre-commit hook formats, stages formatted tracked
  files, and lints, but do not rely on the hook as the only validation.

### Localization

- `src/_locales/en/main.json` is the source of truth. Do not rename existing keys; add new English
  strings first and preserve placeholders, punctuation, and product names.
- Register a new locale in `src/_locales/resources.mjs`. Do not duplicate unchanged model/provider
  labels into every locale when English fallback is appropriate.
- Traditional Chinese belongs in `src/_locales/zh-hant/main.json` and should avoid Simplified
  Chinese terminology.

## 4. Testing and Debugging

Tests use Node's built-in `node:test`/`node:assert` runner. Unit tests mirror source areas under
`tests/unit/`; cross-module scenarios belong under `tests/integration/`. `tests/setup/browser-shim.mjs`
provides extension storage/runtime/tab mocks, and targeted component tests register the loader hooks
in `tests/setup/` to transform JSX or replace browser/UI dependencies.

Run a focused test with the same browser shim, for example:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs
```

Add tests at the narrowest stable boundary: pure parsing/domain behavior first, fake ports/gateways
for cross-context protocols, and the fake end-to-end video-summary test for pipeline changes. Do
not make live provider credentials or network availability a requirement of `npm test`.

### Required validation by change type

- Runtime/code/config changes: run `npm run pretty`, `npm run lint`, `npm test`, and
  `npm run build`; inspect expected artifacts and perform relevant manual extension smoke tests.
- `src/_locales/**`-only changes: run `npm run build` and manually check affected UI strings.
- Markdown/screenshots-only changes: build and browser smoke tests may be skipped. Record
  `Validation skipped: docs/screenshots-only change; no runtime files touched.` in the PR notes.
- Changes under `safari/**`: also run `npm run build:safari` on macOS; document when unavailable.

Manual testing must load the extension, not serve the files over HTTP:

- Chromium: load unpacked `build/chromium/` from `chrome://extensions/`.
- Firefox: load `build/firefox/manifest.json` as a temporary add-on from
  `about:debugging#/runtime/this-firefox`.
- Exercise the changed surface plus the popup, `Ctrl+B`/`Cmd+B` chat, selection tools, context menu,
  and independent panel as relevant. Reload the extension and refresh the page after rebuilding so
  content scripts are reinjected.
- Debug content/UI code in page DevTools, the MV3 background in its service-worker inspector, the
  popup with Inspect Popup, and the Bilibili worker in the offscreen-document context.

## 5. Security and Data Protection

The manifests intentionally have broad host access, cookies, storage, tabs, and request-related
permissions. Do not broaden permissions or expose new web-accessible resources without a concrete
need and review both MV3 and MV2 manifests.

- Treat API keys, provider secrets, access/refresh tokens, cookies, prompts, selections, page text,
  signed media URLs, transcripts, and conversation records as sensitive. Never commit fixtures or
  logs containing real values.
- User configuration, credentials, and sessions currently live in `Browser.storage.local`.
  `providerSecrets` is the canonical provider-key map with legacy fields maintained for backward
  compatibility. Access-token cleanup currently expires stored ChatGPT access tokens after 30 days.
- Keep MediaKit credentials in the background gateway. Content and offscreen messages carry model
  identity/source snapshots, not provider keys. ASR upload/submission must remain explicitly
  user-confirmed because it can send media to and incur cost at a third-party provider.
- Preserve sender checks for privileged runtime messages, popup-only credential operations,
  HTTP(S)-only URL validation, task owner matching, and operation allowlists. Do not turn the narrow
  video gateways into a generic privileged fetch interface.
- Route diagnostic objects through `redactSensitiveFields` or the media URL/error sanitizers.
  Never log raw sessions/configuration, auth headers, prompt/query/selection fields, or signed URL
  query strings.
- The Bilibili path must not bypass DRM, paid/private content, authentication, or regional controls.
  OPFS media is task-scoped and must be cleaned on terminal paths; final summaries persist only when
  the user explicitly archives them or downloads Markdown.
- The README promises that prompts/page content are transmitted only after an AI-powered feature is
  triggered. Preserve that activation boundary when adding automatic behavior.

## 6. Configuration

`src/config/index.mjs` owns model catalogs, defaults, feature switches, storage reads/writes, and
schema migrations. `getUserConfig()` overlays stored values on `defaultConfig`, normalizes language
and API-mode/provider data, migrates legacy keys, and writes migration results back to local
storage. Make new stored settings backward-compatible and add migration tests when meaning changes.

Important related boundaries:

- `src/config/openai-provider-mappings.mjs` maps model groups to provider identities.
- `src/config/model-key-migrations.mjs` canonicalizes renamed model/session values.
- `src/config/language*.mjs` resolves browser and preferred languages.
- `src/manifest.json` is Chromium MV3; `src/manifest.v2.json` is Firefox MV2. Keep versions,
  commands, content-script entries, and compatible permissions aligned where applicable.
- `build.mjs` defines entry points, feature flags, variants, copied artifacts, source maps, cache,
  and packaging. The minimal variant replaces KaTeX/tokenizer behavior and excludes the video
  offscreen entry.
- Bilibili transcription defaults are disabled, speaker identification is enabled, and maximum
  summary output defaults to 20,000 tokens (normalized to 1,000–40,000).

There is no required repository `.env` for normal development. Provider credentials are entered in
the extension UI and stored by the extension. Release scripts consume CI environment secrets; use
the dry-run command to diagnose release configuration without publishing.
