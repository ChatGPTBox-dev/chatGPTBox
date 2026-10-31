This maintenance release adds new API model options and improves floating conversations, streaming, and interaction reliability.

## Changes

### New Models

- Add OpenAI GPT-6.1 Solm Terra, and GPT-6 Sol, Luna API options.
- Add Anthropic Claude Opus 5.5, Claude Sonnet 5.5, and Claude Haiku 5.5 API options.
- Refresh the default-enabled API model list and model-specific request parameters while preserving existing selections and older model options.

### Improvements and Fixes

- Improve floating chat layout and model selection in smaller windows, including viewport-aware sizing, drag recovery, and repositioning after resize (#1096).
- Decode SSE response streams incrementally across split UTF-8 chunks and clear parser metadata on reset (#1068, #1069).
- Clean up theme and selection-tool listeners, discard stale asynchronous work, and handle selection prompt failures (#1066, #1067, #1079, #1081, #1093).
- Dispose of conversation-owned connections on close or unmount and invalidate pending work after disconnect or Stop (#1082, #1083).
- Upgrade KaTeX while preserving the layout of `\smash` expressions (#1114).

### Maintenance

- Update dependencies to address reported security issues and add related regression coverage.
- Add dedicated formatting and lint checks, and pin GitHub Actions to immutable commits.
- Separate Chrome Web Store publishing using API v2 so its failures do not block GitHub releases or Firefox and Edge submissions (#1091).

**Contributors:** @PeterDaveHello, @hamzahamidi

**Full Changelog**: [v2.7.1...v2.7.2](https://github.com/ChatGPTBox-dev/chatGPTBox/compare/v2.7.1...v2.7.2)
