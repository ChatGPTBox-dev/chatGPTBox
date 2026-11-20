# Enhanced Video Summary Hardening Execution Index

> **For agentic workers:** Execute the linked implementation plans in order. Each plan requires superpowers:subagent-driven-development (recommended) or superpowers:executing-plans and contains its own checkbox tracking, TDD cycles, review gates, and commits.

**Goal:** Deliver the approved enhanced video-summary hardening design through three independently reviewable, buildable increments.

**Architecture:** Background owns authenticated task coordination and privileged capabilities; Offscreen owns ephemeral execution and checkpoints; Content owns page identity and UI lifecycle. The protocol increment establishes shared interfaces before media and output work consume them.

**Tech Stack:** Node 22+, ES modules, WebExtension MV3 APIs, Preact, `node:test`, Webpack 5.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-10-06-video-summary-hardening-design.md`.
- Execute plans strictly in the order below.
- Do not introduce a temporary production dual protocol.
- Do not add runtime dependencies or broaden manifest permissions.
- Each increment must end with formatting, lint, full tests, production build, and artifact checks passing.

## Execution Order

### Increment 1: Protocol and Coordinator

Plan: `docs/superpowers/plans/2026-10-07-video-summary-protocol-hardening.md`

Delivers canonical page identity, protocol validation, sender authentication, Background-owned fences,
`activeSlots`/`retainedTasks`, start/retry idempotency, unified attempt authorization, execution release,
task deletion, replay, disconnect cleanup, and atomic production wiring.

Completion gate: the repository uses only the hardened protocol and all runtime variants still build.

### Increment 2: Media and Page Lifecycle

Plan: `docs/superpowers/plans/2026-10-07-video-summary-media-lifecycle.md`

Consumes Increment 1 and delivers exact-fence gateway capabilities, cancellation propagation, media and
upload policy, bounded polling, OPFS limits/cleanup, page-mode lifecycle, and Cancel/Retry UI behavior.

Completion gate: paid/media operations are task-bound, cancellable where locally controllable, bounded,
and exercised through the end-to-end fake pipeline.

### Increment 3: Summary and Sink Safety

Plan: `docs/superpowers/plans/2026-10-07-video-summary-output-safety.md`

Consumes Increments 1 and 2 and delivers role-preserving tool-free model requests, output validity,
changed-budget retry selection, interval-union coverage, sink-specific Markdown serialization, and
allowlisted diagnostics.

Completion gate: summary correctness and output/logging safety tests pass through real provider-body,
archive, and download boundaries.

## Final Acceptance

After all three plans are complete, run:

```bash
npm run pretty
npm run lint
npm test
npm run build
```

Verify `VideoSummaryOffscreen.html/js` exist only in full Chromium output, then perform the manual
Chrome/Edge smoke tests listed in each plan. Do not add a separate verification commit when no files
change.
