import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  assertYouTubePlayability,
  assertYouTubePlayerResponseIdentity,
  extractYouTubePlayerResponse,
  getYouTubeWatchIdentity,
  normalizeYouTubeAudioCandidates,
  normalizeYouTubeCaptionTracks,
  parseYouTubeTimedText,
} from '../../../src/content-script/site-adapters/youtube/media-source.mjs'

const fixtureUrl = (name) => new URL(`../../fixtures/youtube/${name}`, import.meta.url)
const loadJson = async (name) => JSON.parse(await readFile(fixtureUrl(name), 'utf8'))
const loadText = (name) => readFile(fixtureUrl(name), 'utf8')

const validVideoId = 'SYNTHVID001'

test('accepts only exact watch paths with bounded YouTube video IDs', () => {
  const pageIdentity = {
    platform: 'youtube',
    videoId: validVideoId,
    mediaId: validVideoId,
  }
  assert.deepEqual(getYouTubeWatchIdentity(`https://www.youtube.com/watch?v=${validVideoId}`), {
    supported: true,
    pageIdentity,
  })
  assert.deepEqual(
    getYouTubeWatchIdentity(new URL(`https://www.youtube.com/watch?v=${validVideoId}&t=2`)),
    { supported: true, pageIdentity },
  )

  for (const input of [
    `https://www.youtube.com/watch/?v=${validVideoId}`,
    `https://www.youtube.com/shorts/${validVideoId}`,
    `https://www.youtube.com/embed/${validVideoId}`,
    `https://www.youtube.com/live/${validVideoId}`,
    `https://www.youtube.com/watch?v=${validVideoId}x`,
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=SYNTHVID!01',
    'https://www.youtube.com/watch',
  ]) {
    assert.deepEqual(getYouTubeWatchIdentity(input), { supported: false, pageIdentity: null })
  }
})

test('extracts a bounded balanced player response with escaped braces and quotes', async () => {
  const html = await loadText('watch-authored-and-auto.html')
  const expected = await loadJson('player-response-authored-auto.json')
  assert.deepEqual(extractYouTubePlayerResponse(html), expected)
})

test('rejects missing, malformed, and incomplete player responses', () => {
  assert.throws(() => extractYouTubePlayerResponse('<html></html>'), {
    message: 'YOUTUBE_PLAYER_RESPONSE_NOT_FOUND',
  })
  assert.throws(
    () => extractYouTubePlayerResponse('<script>var ytInitialPlayerResponse = notJson;</script>'),
    { message: 'YOUTUBE_PLAYER_RESPONSE_MALFORMED' },
  )
  assert.throws(
    () =>
      extractYouTubePlayerResponse(
        '<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"SYNTHVID001"}</script>',
      ),
    { message: 'YOUTUBE_PLAYER_RESPONSE_INCOMPLETE' },
  )
})

test('asserts player-response identity', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  assert.doesNotThrow(() =>
    assertYouTubePlayerResponseIdentity({ playerResponse, expectedVideoId: validVideoId }),
  )
  assert.throws(
    () =>
      assertYouTubePlayerResponseIdentity({
        playerResponse,
        expectedVideoId: 'OTHERID0001',
      }),
    { message: 'YOUTUBE_PLAYER_RESPONSE_IDENTITY_MISMATCH' },
  )
  assert.throws(
    () =>
      assertYouTubePlayerResponseIdentity({ playerResponse: {}, expectedVideoId: validVideoId }),
    { message: 'YOUTUBE_PLAYER_RESPONSE_IDENTITY_INVALID' },
  )
})

test('accepts playable on-demand responses and rejects unavailable or live responses', async () => {
  const playable = await loadJson('player-response-authored-auto.json')
  const unavailable = await loadJson('player-response-unavailable.json')
  assert.doesNotThrow(() => assertYouTubePlayability(playable))
  assert.throws(() => assertYouTubePlayability(unavailable), {
    message: 'YOUTUBE_VIDEO_UNPLAYABLE',
  })
  assert.throws(
    () =>
      assertYouTubePlayability({
        ...playable,
        videoDetails: { ...playable.videoDetails, isLiveContent: true },
      }),
    { message: 'YOUTUBE_LIVE_UNSUPPORTED' },
  )
})

test('normalizes authored captions before automatic captions with safe stable IDs', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const tracks = normalizeYouTubeCaptionTracks(playerResponse)

  assert.deepEqual(
    tracks.map(({ language, label, sourceKind }) => ({ language, label, sourceKind })),
    [
      { language: 'en', label: 'English', sourceKind: 'author' },
      { language: 'en', label: 'English (automatic)', sourceKind: 'automatic' },
    ],
  )
  assert.deepEqual(
    tracks.map(({ id }) => id),
    ['youtube-caption-author-en-.en', 'youtube-caption-automatic-en-a.en'],
  )
  assert.equal(
    tracks.every(({ id }) => !id.includes('http')),
    true,
  )
  assert.equal(
    tracks.every(({ baseUrl }) => baseUrl.startsWith('https://')),
    true,
  )
  assert.deepEqual(tracks[0].translationLanguages, [{ language: 'fr', label: 'French' }])
  assert.doesNotThrow(() => structuredClone(tracks))
})

test('skips caption descriptors without a valid HTTPS URL', () => {
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'http://captions.example.invalid', languageCode: 'en' },
          { baseUrl: 'not a URL', languageCode: 'fr' },
        ],
      },
    },
  }
  assert.deepEqual(normalizeYouTubeCaptionTracks(playerResponse), [])
})

test('parses timed-text timestamps, entities, ordering, and duplicate events', async () => {
  const payload = await loadJson('timed-text-events.json')
  assert.deepEqual(parseYouTubeTimedText(payload), [
    { startMs: 0, endMs: 1500, text: "First <cue> 'quoted'" },
    { startMs: 2000, endMs: 3250, text: 'Second & short' },
  ])
})

test('accepts timed-text JSON strings and rejects malformed payloads safely', () => {
  assert.deepEqual(
    parseYouTubeTimedText(
      JSON.stringify({
        events: [{ tStartMs: 10, dDurationMs: 20, segs: [{ utf8: '&quot;x&quot;' }] }],
      }),
    ),
    [{ startMs: 10, endMs: 30, text: '"x"' }],
  )
  assert.throws(() => parseYouTubeTimedText('{broken'), {
    message: 'YOUTUBE_TIMED_TEXT_MALFORMED',
  })
  assert.deepEqual(parseYouTubeTimedText({}), [])
})

test('normalizes only HTTPS audio-only adaptive candidates and secure backups', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const [candidate] = normalizeYouTubeAudioCandidates(playerResponse)

  assert.deepEqual(candidate, {
    id: '140',
    mediaMetadata: {
      kind: 'audio',
      container: 'audio/mp4',
      codec: 'mp4a.40.2',
      contentLength: 193500,
      durationMs: 12000,
      bandwidth: 129000,
    },
    remoteCandidate: {
      url: 'https://audio-primary.example.invalid/media.m4a?expire=4102444800&fixture=primary',
      expiresAt: 4102444800000,
    },
    localFetchRecipe: {
      primaryUrl:
        'https://audio-primary.example.invalid/media.m4a?expire=4102444800&fixture=primary',
      backupUrls: [
        'https://audio-backup.example.invalid/media.m4a?expire=4102444800&fixture=backup',
      ],
      expiresAt: 4102444800000,
      credentialMode: 'include',
      rangeSupported: null,
      requiredRequestOrigin: 'https://www.youtube.com/',
    },
  })
  assert.doesNotThrow(() => structuredClone(candidate))
})

test('returns no audio candidates when adaptive formats are absent', () => {
  assert.deepEqual(normalizeYouTubeAudioCandidates({}), [])
})
