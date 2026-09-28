import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHUNK_SUMMARY_TOOL,
  VIDEO_SUMMARY_TOOL,
  normalizeChunkSummaryArguments,
  normalizeVideoSummaryArguments,
} from '../../../src/video-summary/summary-tools.mjs'

function getRequiredKeys(schema) {
  return Array.isArray(schema?.required) ? schema.required.slice() : []
}

test('summary tool contracts are strict JSON schemas with exact names', () => {
  for (const [tool, expectedName] of [
    [CHUNK_SUMMARY_TOOL, 'submit_chunk_summary'],
    [VIDEO_SUMMARY_TOOL, 'submit_video_summary'],
  ]) {
    assert.equal(tool.name, expectedName)

    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)

    const required = getRequiredKeys(tool.parameters).sort()
    const propertyKeys = Object.keys(tool.parameters.properties || {}).sort()
    assert.deepEqual(required, propertyKeys)

    for (const [key, schema] of Object.entries(tool.parameters.properties || {})) {
      if (schema.type === 'object') {
        assert.equal(
          schema.additionalProperties,
          false,
          `${expectedName}.${key} additionalProperties`,
        )
      }
    }
  }
})

test('normalizeChunkSummaryArguments filters out-of-range segmentIds, trims text, and rejects empty localSummary', () => {
  const allowedPrimaryIds = new Set(['s1', 's2'])

  assert.throws(
    () =>
      normalizeChunkSummaryArguments(
        {
          localSummary: '   ',
          chapterStarts: [],
          keyMoments: [],
          keyPoints: [],
        },
        allowedPrimaryIds,
      ),
    /MODEL_OUTPUT_SCHEMA_INVALID/,
  )

  const normalized = normalizeChunkSummaryArguments(
    {
      localSummary: '  local summary  ',
      chapterStarts: [
        { segmentId: 's1', title: '  Title  ', summary: '  Summary  ' },
        { segmentId: 's3', title: 'drop', summary: 'drop' },
      ],
      keyMoments: [
        { segmentId: 's2', point: '  Moment  ' },
        { segmentId: 's3', point: 'drop' },
      ],
      keyPoints: ['  point 1  ', '  ', 'point 2'],
    },
    allowedPrimaryIds,
  )

  assert.deepEqual(normalized.chapterStarts, [
    { segmentId: 's1', title: 'Title', summary: 'Summary' },
  ])
  assert.deepEqual(normalized.keyMoments, [{ segmentId: 's2', point: 'Moment' }])
  assert.deepEqual(normalized.keyPoints, ['point 1', 'point 2'])
  assert.equal(normalized.localSummary, 'local summary')
})

test('normalizeVideoSummaryArguments trims text and rejects empty overview', () => {
  assert.throws(
    () =>
      normalizeVideoSummaryArguments({
        overview: '   ',
        chapterStarts: [],
        keyMoments: [],
        keyPoints: [],
      }),
    /MODEL_OUTPUT_SCHEMA_INVALID/,
  )

  const normalized = normalizeVideoSummaryArguments({
    overview: '  overview  ',
    chapterStarts: [{ segmentId: 's1', title: '  t  ', summary: '  s  ' }],
    keyMoments: [{ segmentId: 's2', point: '  p  ' }],
    keyPoints: ['  k1  '],
  })

  assert.equal(normalized.overview, 'overview')
  assert.deepEqual(normalized.chapterStarts, [{ segmentId: 's1', title: 't', summary: 's' }])
  assert.deepEqual(normalized.keyMoments, [{ segmentId: 's2', point: 'p' }])
  assert.deepEqual(normalized.keyPoints, ['k1'])
})
