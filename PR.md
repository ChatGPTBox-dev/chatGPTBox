## Summary

Corrects LLM provider naming to follow common terminology: OpenAI API and Anthropic API for API access, while keeping ChatGPT and Claude for web products.

## Changes

**UI Display Names:**
- `ChatGPT (API)` → `OpenAI (API)`
- `ChatGPT (Azure API)` → `Azure OpenAI (API)`
- `Claude.ai (API)` → `Anthropic (API)` (all Claude API model variants)

**Locale Strings:**
- `Custom Claude API Url` → `Custom Anthropic API Url`
- Add `Anthropic API Key` with translations in all 13 locales

**Internal Code:**
- Rename `generateAnswersWithChatgptApi` → `generateAnswersWithOpenAiApi`
- Rename `generateAnswersWithChatgptApiCompat` → `generateAnswersWithOpenAiApiCompat`

**Config Keys:**
- `claudeApiKey` → `anthropicApiKey`
- `customClaudeApiUrl` → `customAnthropicApiUrl`
- Add migration logic to preserve existing user settings:
  - Persists new keys before removing old ones
  - Always migrates when old keys exist (handles legacy backup imports)

**Unchanged:**
- Web mode names (`ChatGPT (Web)`, `Claude.ai (Web)`) - these refer to web products

## Rationale

"OpenAI API" and "Anthropic API" are the commonly used terms when referring to programmatic API access. Product names like ChatGPT and Claude are appropriate for web interfaces, but less precise for API settings.
