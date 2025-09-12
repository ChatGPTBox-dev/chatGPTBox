# ChatGPTBox - Browser Extension

ChatGPTBox is a cross-platform browser extension that deeply integrates ChatGPT and other AI models into web browsing. The extension provides chat dialogs, selection tools, site-specific adapters, and AI-powered features across the web.

Always reference these instructions first and fall back to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

### Bootstrap and Build

- Install dependencies: `npm ci` -- npm audit warnings may appear; for development-only dependencies they generally do not affect the shipped extension. Review and address runtime-impacting advisories separately.
- Development build: `npm run dev` -- runs webpack in watch mode. Do not kill mid-compilation, but stop gracefully when switching branches or after dependency/config changes, then restart to avoid stale watchers and inconsistent state.
- Production build: `npm run build` -- Avoid force-killing mid-bundle; stop, fix, then rebuild.
  See "Time Expectations" and "Build Issues" for the hung-build policy and recovery steps.
- Analyze bundle: `npm run analyze` -- Inspects the size of webpack output files.
- Format code: `npm run pretty` -- uses Prettier to format all JS/JSX/CSS files. Run this before linting.
- Lint code: `npm run lint` -- uses ESLint.
- Safari build: `npm run build:safari` (see Platform-Specific Instructions for details)

### Build Output Structure

Production build creates multiple variants in `build/` directory:

- `chromium/` - Chromium-based browsers (Chrome, Edge) with full features
- `firefox/` - Firefox with manifest v2
- `chromium-without-katex-and-tiktoken/` - Minimal build without math rendering and token encoding
- `firefox-without-katex-and-tiktoken/` - Minimal Firefox build without math rendering and token encoding
- Distribution artifacts:
  - Chromium: `build/chromium.zip`
  - Firefox: `build/firefox.zip`
  - Safari: `Fission - ChatBox.app` and `safari.dmg` (see Safari Build section for details)

## Architecture Overview

The project uses Preact (for React-like components), SCSS (for styling), and Webpack 5 (for bundling).

### Key Components

- **Content Script** (`src/content-script/index.jsx`) - Injected into all web pages, provides main chat functionality
- **Background Script** (`src/background/index.mjs`) - Handles browser APIs and cross-page communication
- **Popup** (`src/popup/`) - Extension popup interface accessible via browser toolbar
- **Independent Panel** (`src/pages/IndependentPanel/`) - Standalone chat page and side panel
- **Site Adapters** (`src/content-script/site-adapters/`) - Custom integrations for specific websites (Reddit, GitHub, YouTube, etc.)
- **Selection Tools** (`src/content-script/selection-tools/`) - Text selection features (translate, summarize, explain, etc.)

### Manifests

- `src/manifest.json` - Manifest v3 for Chromium browsers (Chrome, Edge, Opera, etc.)
- `src/manifest.v2.json` - Manifest v2 for Firefox (current status; future MV3 migration may change this)
  - Background runs as service worker (MV3) vs background page (MV2)
  - Different permission models between manifest versions

## Testing and Validation

### Manual Browser Extension Testing (CRITICAL)

This browser extension has no automated tests, so manual testing is essential:

1. **Load Extension in Browser:**
   - Chrome: Go to `chrome://extensions/`, enable Developer Mode, click "Load unpacked", then select the folder `build/chromium/` (the folder must contain `manifest.json`).
   - Firefox: Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", then select the `manifest.json` file inside `build/firefox/` (do not select the folder directly). Note: Temporary (unsigned) add-ons are removed on browser restart; reload them via the same "This Firefox" page after every restart, and some environments with enterprise policies may block loading from file.
   - **Important**: Extension files cannot be tested by serving them via HTTP server - they must be loaded as a proper browser extension.

2. **Core Functionality Tests:**
   - Press `Ctrl+B` (Windows/Linux) or `⌘+B` (macOS) to open the chat dialog on any webpage
   - Select text on a page, verify selection tools appear
   - Right-click and verify "Ask ChatGPT" context menu appears
   - Click extension icon to open popup
   - Press `Ctrl+Shift+H` (Windows/Linux) or `⌘+Shift+H` (macOS) to open the independent conversation page

3. **Site Integration Tests:**
   - Visit YouTube.com, verify video summary features work
   - Visit Reddit.com, verify ChatGPT integration appears in sidebar
   - Visit GitHub.com, verify code analysis features work
   - Visit Google.com search results, verify ChatGPT responses appear

4. **Configuration Tests:**
   - Open extension popup, navigate through tabs (General, Feature Pages, Modules > Selection Tools, Modules > Sites, Advanced)
   - Test API mode switching (Web API vs OpenAI API) under Modules > API Modes
   - If using Web APIs, ensure you are signed in to the provider in the same browser profile; if using API Keys, configure valid keys in settings
   - Verify language settings work

Debugging tips:

- Inspect background Service Worker, page DevTools for content scripts, and use "Inspect popup" for the popup UI
- After rebuilds, reload the extension and refresh the page to re‑inject content scripts

### Build Validation

Ensure these files exist in `build/chromium/` after successful build:

- `manifest.json` (contains proper extension metadata)
- `background.js` (service worker bundle)
- `content-script.js` (main functionality)
- `content-script.css` (styling)
- `popup.html` and `popup.js` (popup interface)
- `IndependentPanel.html` and `IndependentPanel.js` (standalone chat page)
- `shared.js` (shared vendor/runtime; size varies by environment and dependencies)
- `logo.png` (extension icon)
- `rules.json` (declarative net request rules)

Bundle sizes are approximate and not validation criteria.

### Verify Script Limitations

- `npm run verify` tests search engine configurations by attempting to fetch search results from external search engines (Bing, Yahoo, Baidu, Naver) to validate that the site adapters can parse and handle real responses.
- **Successful validation**: For each search engine, the script expects to receive a valid HTTP response (status 200) and to successfully extract and parse search results using the corresponding site adapter. If the adapter can parse the expected data structure from the response, the test is considered a pass.
- **Expected failure modes**: In sandboxed or CI environments, the script may fail due to network restrictions (e.g., DNS errors, timeouts, connection refused), HTTP errors (e.g., 403, 429, 503), or changes in the search engine's response format. These failures are expected and do **not** indicate build problems.
- If you see network or HTTP errors during `npm run verify`, you can safely ignore them unless you are specifically testing or updating site adapter logic.

Usage notes:

- Default checks target: `https://www.bing.com/search?q=hello`, `https://search.yahoo.co.jp/search?p=hello`, `https://www.baidu.com/s?wd=hello`, `https://search.naver.com/search.naver?query=hello`
- Optional engines (may be blocked by region or anti-bot measures): Google, DuckDuckGo, Brave, Searx.
- Troubleshooting: If a site fails, try adjusting `Accept-Language`/`User-Agent` headers in the script, update the site's selector arrays with ordered fallbacks, or temporarily reduce the test to a single URL while iterating.

## Development Workflow

### Code Style, Quality, and File Organization

- ALWAYS run `npm run lint` before committing - CI will fail otherwise
- ALWAYS run `npm run pretty` to format code consistently
- ESLint configuration in `.eslintrc.json` enforces React/JSX standards
- Prettier configuration in `.prettierrc` handles formatting

- Naming conventions: component directories use PascalCase; feature folders use kebab-case; entry files are typically `index.jsx` or `index.mjs`
- Avoid heavy dependencies; if necessary, justify and keep bundle size under control

**Pre-commit hooks automatically:**

1. Run prettier formatting
2. Stage formatted files
3. Run lint checks

**Key file locations:**

- Configuration: `src/config/index.mjs`
- API integrations: `src/services/apis/`
- Localization: `src/_locales/`
- UI components: `src/components/`
- Utilities: `src/utils/`

### Commits & PRs

- Keep changes minimal and focused. Avoid unrelated refactors in the same PR.
- Commit subject: imperative, capitalize first word; separate subject/body with a blank line; wrap at ~72 characters; explain what and why.
- PRs: link related issues, summarize scope/behavior changes; include screenshots for UI changes.
- Note i18n updates in PR description when `src/_locales/` changes.

### Directory Structure

```text
src/
├── background/             # Background script/service worker
├── components/             # Reusable UI components
├── config/                 # Configuration management
├── content-script/         # Main content script and features
│   ├── site-adapters/      # Website-specific integrations
│   ├── selection-tools/    # Text selection features
│   └── menu-tools/         # Context menu features
├── pages/IndependentPanel/ # Standalone chat page
├── popup/                  # Extension popup
├── services/               # API clients and wrappers
└── utils/                  # Helper functions
```

## Platform-Specific Instructions

### Safari Build (macOS Only)

- Run `npm run build:safari` (requires macOS with Xcode installed)
- Creates `Fission - ChatBox.app` bundle and `safari.dmg` installer
- Uses `safari/build.sh` script with platform-specific patches

### Cross-Browser Compatibility

- Uses `webextension-polyfill` for API compatibility

## Security & Privacy

- Do not commit secrets, API keys, or user data
- Keep manifest permissions minimal and justify any additions
- Centralize network/API logic under `src/services/apis/` and keep endpoints auditable

## Localization

- Source of truth: `src/_locales/en/main.json`; do not change keys
- Add new strings to `en/main.json` first, then propagate to other locales
- Register new locales in `src/_locales/resources.mjs`
- Preserve placeholders and product names; keep punctuation/quotes intact
- For Traditional Chinese (Taiwan), use `src/_locales/zh-hant/main.json` and avoid zh‑CN terms

## AI Model Support

The extension supports multiple AI providers:

- **Web (cookie-based)**: ChatGPT (Web), Claude (Web), Kimi.Moonshot (Web), Bing (Web), Bard (Web), Poe (Web)
- **APIs (key-based)**: OpenAI (API), Azure OpenAI (API), Anthropic (Claude API), OpenRouter (API), AI/ML (API), DeepSeek (API), Ollama (local), ChatGLM (API), Waylaidwanderer (API), Kimi.Moonshot (API)
- **Custom/self-hosted**: Alternative endpoints and self-hosted backends

## Troubleshooting

### Build Issues

- Build failures: Check Node.js version (requires Node 20+), clear caches and rebuild.
  - macOS/Linux: `rm -rf node_modules && npm ci && rm -rf node_modules/.cache build/ dist/`
  - Windows (PowerShell): `Remove-Item -Recurse -Force node_modules, build, dist; if (Test-Path node_modules\.cache) { Remove-Item -Recurse -Force node_modules\.cache }; npm ci`
- "Module not found" errors: Usually indicate missing `npm ci`

### Runtime Issues

- Extension not loading: Check console for manifest errors
- API not working: Verify browser has required permissions and cookies
- Selection tools not appearing: Check if content script loaded correctly

### Common Development Tasks

- Adding new site adapter: Create new file in `src/content-script/site-adapters/`, register it in `src/content-script/site-adapters/index.mjs`, keep selectors minimal with feature detection, and verify on Chromium/Firefox
- Adding new selection tool: Modify `src/content-script/selection-tools/`, keep UI and logic separate, and reuse helpers in `src/utils/`
- Updating API integration: Modify files in `src/services/apis/`
- Adding new UI component: Create in `src/components/`

## Time Expectations

- Do not interrupt builds or long-running commands unless they appear hung or unresponsive.
- `npm ci`: ~30 seconds
- `npm run build`: ~35 seconds (measured). Set timeout to 5-10 minutes for system variations.
- `npm run dev`: ~15 seconds initial build, then watches for changes; use Ctrl+C to stop when switching branches or after config/dependency changes.
- `npm run lint`: ~5 seconds
- Manual extension testing: 5-10 minutes for thorough validation
- Safari build: 2-5 minutes (macOS only)

## Critical Validation Steps

1. ALWAYS run `npm run build` after any code changes
2. ALWAYS manually load and test the built extension in a browser (no automated testing available)
3. ALWAYS verify the build creates expected file structure (non-empty bundles, no missing files)
4. ALWAYS test core extension functionality (popup, content script injection, keyboard shortcuts)

Always build and manually test the extension in a browser before considering any change complete. Simply running the build is NOT sufficient - you must load the extension and test actual functionality.

---

Most of this document was generated by AI and reviewed under human supervision. If you find any clear errors while using it, please submit corrections with supporting evidence where possible.
