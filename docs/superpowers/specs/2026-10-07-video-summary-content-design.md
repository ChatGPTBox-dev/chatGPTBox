# Video Summary Content Design

**Date:** 2026-10-07

**Status:** Approved for implementation planning

## 1. Purpose

Improve the enhanced video-summary output by removing overlap between key points and key moments
and by producing richer summaries that adapt to video length. The legacy subtitle-summary path is
unchanged.

## 2. Scope

### Included

- Replace the separate final-summary key-points and key-moments sections with one timestamped key
  content section.
- Remove `keyPoints` from the enhanced pipeline's parsed synthesis result, structured result, output
  validity checks, UI, Markdown export, and follow-up question context.
- Continue using `keyMoments` as the internal structured-result field, while presenting it to users
  as “Key content” and localized equivalents.
- Make the requested amount of key content depend on the video duration.
- Enrich the overview, key content, and chapter descriptions while keeping them factual,
  source-grounded, and non-repetitive.
- Update focused tests for prompts, parsing, result building, rendering, export, validity, and task
  execution.

### Excluded

- Changes to the Bilibili and YouTube legacy subtitle-summary prompts.
- Renaming `keyMoments` to a new wire or persistence field.
- Changes to transcription, chunking, provider selection, model token settings, coverage reporting,
  retry behavior, or task routing.
- Compatibility rendering for archived or checkpointed results that contain only `keyPoints`.

## 3. Output Contract

The enhanced final synthesis contains exactly these user-facing sections:

1. Overall summary
2. Key content
3. Chapters

`keyMoments` remains the internal field for key content. Each entry has the existing shape:

```js
{
  segmentId,
  startMs,
  point,
}
```

Every model-generated key-content item must use a validated transcript segment marker. The result
builder resolves the marker to `startMs`, removes invalid or duplicate items, and sorts anchored
items chronologically. Existing fallback candidates from chunk summaries remain available when final
synthesis is unavailable.

`keyPoints` is removed from final-summary parsing and from the structured result returned by the
runner. Chunk-level `keyPoints` remain internal evidence supplied to final synthesis; they are not a
public final-result section.

## 4. Adaptive Detail

The final prompt derives the target key-content range from the transcription duration:

| Video duration | Target key content |
| --- | --- |
| Up to 10 minutes | 4–6 items |
| Over 10 and up to 30 minutes | 6–10 items |
| Over 30 and up to 60 minutes | 10–15 items |
| Over 60 minutes | 15–20 items |

These are target ranges rather than quotas. The model must not pad sparse material, duplicate ideas,
or invent unsupported details to reach the lower bound.

The overview should explain the topic and necessary context, follow the main argument or narrative,
include important evidence or examples, and state conclusions and implications supported by the
source. Key-content entries should combine the important claim or event with its relevant evidence,
example, reasoning, or consequence. Chapter descriptions should explain both what each section
covers and how it advances the video.

The prompt explicitly assigns different responsibilities to avoid repetition:

- the overview provides synthesis and narrative;
- key content captures the most important timestamped information;
- chapters provide navigation and structural progression.

Concrete facts, names, numbers, caveats, and examples should be retained when important. Content
must remain concise enough to scan and must never add claims absent from the transcript.

## 5. Prompt and Parsing Changes

The final prompt accepts video duration in addition to chunk results. It requests the appropriate
key-content range and uses one fixed heading, `## 关键内容`, with the English alias `Key content`.
The former final headings and instructions for `核心要点` and `关键时刻` are removed.

Final parsing recognizes the new key-content heading and maps its entries directly to `keyMoments`.
The final `keyPointCount` and `keyPointCharacters` limits are removed. The key-content maximum is 20
items, and each item receives enough character capacity to include concise supporting detail. The
overview and chapter-description limits are increased enough to support the richer instructions
without allowing unbounded model output.

Chunk prompts and chunk parsing retain local summaries, local key points, and candidate locations.
Those compact intermediate fields continue to give final synthesis source-ordered evidence and
validated anchors.

## 6. Consumers

- The result builder no longer constructs or returns final `keyPoints`.
- Output validity considers the overview, chapters, and `keyMoments` only.
- The video summary view renders one “Key content” section from `keyMoments` and removes the separate
  “Key points” section.
- Markdown export emits one “Key Content” section and omits “Key Points” and “Key Moments”.
- Follow-up question context includes key content instead of key points.
- Localization adds or updates the user-facing “Key content” label in English, Simplified Chinese,
  and Traditional Chinese. Obsolete labels are removed only when no other code uses them.

## 7. Error and Degraded Behavior

If final synthesis fails, chunk candidate locations continue to populate `keyMoments`; local chunk
summaries continue to populate the overview; chapter fallback behavior remains unchanged. Missing or
invalid anchors are handled by the existing warning path. A result is not considered meaningful
solely because an obsolete `keyPoints` field exists.

Older stored results containing only `keyPoints` are intentionally not adapted or rendered. This is
an accepted compatibility break.

## 8. Testing

Use test-driven development for each behavior change. Focused tests cover:

- duration-to-target-range selection at 10, 30, and 60 minute boundaries;
- the richer final prompt, fixed headings, division of responsibilities, and anti-padding language;
- final parsing into `keyMoments` without `keyPoints`;
- chronological ordering, deduplication, anchor validation, and chunk-candidate fallback;
- structured results with no `keyPoints` property;
- output validity without `keyPoints` support;
- one Key content UI section with timestamp seeking;
- one Key Content Markdown export section;
- follow-up question context using key content;
- unchanged legacy subtitle-summary prompts.

After focused tests pass, run:

1. `npm run pretty`
2. `npm run lint`
3. `npm test`
4. `npm run build`

## 9. Success Criteria

- Enhanced summaries no longer present duplicate key-points and key-moments sections.
- The final structured result contains `keyMoments` but not `keyPoints`.
- Key content is timestamped, deduplicated, source-grounded, and chronologically ordered.
- Requested detail scales from 4–6 items for short videos to 15–20 for videos over one hour.
- Overview and chapter descriptions provide materially richer context without repeating key content.
- Legacy subtitle-summary behavior remains unchanged.
- Formatting, lint, tests, and production build pass.
