function createOutputSchemaError() {
  const error = new Error('MODEL_OUTPUT_SCHEMA_INVALID')
  error.code = 'MODEL_OUTPUT_SCHEMA_INVALID'
  return error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function normalizeKeyPoints(value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => normalizeString(entry)).filter(Boolean)
}

function normalizeChapterStarts(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      segmentId: normalizeString(entry.segmentId),
      title: normalizeString(entry.title),
      summary: normalizeString(entry.summary),
    }))
    .filter((entry) => entry.segmentId && entry.title)
}

function normalizeKeyMoments(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      segmentId: normalizeString(entry.segmentId),
      point: normalizeString(entry.point),
    }))
    .filter((entry) => entry.segmentId && entry.point)
}

function filterByAllowedPrimaryIds(items, allowedPrimaryIds) {
  if (!(allowedPrimaryIds instanceof Set)) return items
  return items.filter((entry) => allowedPrimaryIds.has(entry.segmentId))
}

export function normalizeChunkSummaryArguments(args, allowedPrimaryIds) {
  if (!isPlainObject(args)) throw createOutputSchemaError()

  const localSummary = normalizeString(args.localSummary)
  if (!localSummary) throw createOutputSchemaError()

  return {
    localSummary,
    chapterStarts: filterByAllowedPrimaryIds(
      normalizeChapterStarts(args.chapterStarts),
      allowedPrimaryIds,
    ),
    keyMoments: filterByAllowedPrimaryIds(normalizeKeyMoments(args.keyMoments), allowedPrimaryIds),
    keyPoints: normalizeKeyPoints(args.keyPoints),
  }
}

export function normalizeVideoSummaryArguments(args) {
  if (!isPlainObject(args)) throw createOutputSchemaError()

  const overview = normalizeString(args.overview)
  if (!overview) throw createOutputSchemaError()

  return {
    overview,
    chapterStarts: normalizeChapterStarts(args.chapterStarts),
    keyMoments: normalizeKeyMoments(args.keyMoments),
    keyPoints: normalizeKeyPoints(args.keyPoints),
  }
}

const SEGMENT_ID_SCHEMA = Object.freeze({ type: 'string' })
const STRING_SCHEMA = Object.freeze({ type: 'string' })

const CHAPTER_START_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['segmentId', 'title', 'summary'],
  properties: {
    segmentId: SEGMENT_ID_SCHEMA,
    title: STRING_SCHEMA,
    summary: STRING_SCHEMA,
  },
})

const KEY_MOMENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['segmentId', 'point'],
  properties: {
    segmentId: SEGMENT_ID_SCHEMA,
    point: STRING_SCHEMA,
  },
})

const CHUNK_ARGUMENTS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['localSummary', 'chapterStarts', 'keyMoments', 'keyPoints'],
  properties: {
    localSummary: STRING_SCHEMA,
    chapterStarts: {
      type: 'array',
      items: CHAPTER_START_SCHEMA,
    },
    keyMoments: {
      type: 'array',
      items: KEY_MOMENT_SCHEMA,
    },
    keyPoints: {
      type: 'array',
      items: STRING_SCHEMA,
    },
  },
})

const VIDEO_ARGUMENTS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'chapterStarts', 'keyMoments', 'keyPoints'],
  properties: {
    overview: STRING_SCHEMA,
    chapterStarts: {
      type: 'array',
      items: CHAPTER_START_SCHEMA,
    },
    keyMoments: {
      type: 'array',
      items: KEY_MOMENT_SCHEMA,
    },
    keyPoints: {
      type: 'array',
      items: STRING_SCHEMA,
    },
  },
})

export const CHUNK_SUMMARY_TOOL = Object.freeze({
  name: 'submit_chunk_summary',
  description:
    'Submit a structured local summary for one transcript chunk. Use only primary segment IDs.',
  parameters: CHUNK_ARGUMENTS_SCHEMA,
})

export const VIDEO_SUMMARY_TOOL = Object.freeze({
  name: 'submit_video_summary',
  description: 'Submit a structured final summary synthesized from chunk summaries.',
  parameters: VIDEO_ARGUMENTS_SCHEMA,
})
