import assert from 'node:assert/strict'
import test from 'node:test'

import {
  orderSubtitleTracks,
  selectPreferredSubtitleTrack,
} from '../../../src/video-summary/subtitle-tracks.mjs'

function cue(text = 'usable') {
  return { startMs: 0, endMs: 1000, text }
}

const tracks = [
  { id: 'auto-en', language: 'en', sourceKind: 'automatic', cues: [cue('a')] },
  { id: 'author-ja', language: 'ja', sourceKind: 'author', cues: [cue('b')] },
  { id: 'author-en', language: 'en-US', sourceKind: 'author', cues: [cue('c')] },
]

test('orders usable subtitle tracks by all source kinds without mutating input', () => {
  const input = [
    { id: 'unknown', language: 'fr', sourceKind: 'unknown', cues: [cue()] },
    { id: 'ai', language: 'zh-CN', sourceKind: 'bilibili-ai', cues: [cue()] },
    { id: 'automatic', language: 'en', sourceKind: 'automatic', cues: [cue()] },
    { id: 'author', language: 'ja', sourceKind: 'author', cues: [cue()] },
  ]

  assert.deepEqual(
    orderSubtitleTracks(input).map(({ id }) => id),
    ['author', 'automatic', 'ai', 'unknown'],
  )
  assert.deepEqual(
    input.map(({ id }) => id),
    ['unknown', 'ai', 'automatic', 'author'],
  )
})

test('preserves input order among tracks with the same source kind', () => {
  assert.deepEqual(
    orderSubtitleTracks(tracks).map(({ id }) => id),
    ['author-ja', 'author-en', 'auto-en'],
  )
})

test('filters tracks with missing IDs or malformed and empty cues', () => {
  assert.deepEqual(
    orderSubtitleTracks([
      { id: '', sourceKind: 'author', cues: [cue()] },
      { id: 'missing-cues', sourceKind: 'author' },
      { id: 'malformed-cues', sourceKind: 'author', cues: {} },
      { id: 'empty-cues', sourceKind: 'author', cues: [] },
      { id: 'usable', sourceKind: 'author', cues: [cue()] },
    ]).map(({ id }) => id),
    ['usable'],
  )
})

test('selects an exact locale match within the highest available source rank', () => {
  const candidates = [
    { id: 'author-en', language: 'en', sourceKind: 'author', cues: [cue()] },
    { id: 'author-en-us', language: 'en-US', sourceKind: 'author', cues: [cue()] },
    { id: 'auto-en-us', language: 'en-US', sourceKind: 'automatic', cues: [cue()] },
  ]

  assert.equal(selectPreferredSubtitleTrack(candidates, 'en-US').id, 'author-en-us')
})

test('selects a base-language match within the highest available source rank', () => {
  assert.equal(selectPreferredSubtitleTrack(tracks, 'en').id, 'author-en')
  assert.equal(selectPreferredSubtitleTrack(tracks, 'en-GB').id, 'author-en')
})

test('falls back to the first ordered usable track', () => {
  assert.equal(selectPreferredSubtitleTrack(tracks, 'fr').id, 'author-ja')
  assert.equal(selectPreferredSubtitleTrack([], 'en'), null)
})
