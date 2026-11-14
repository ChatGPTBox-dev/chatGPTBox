import assert from 'node:assert/strict'
import test from 'node:test'
import {
  localFetchRequiresUnsupportedHeaders,
  validateCandidateDuration,
  validateCanonicalDuration,
  validateInitialMediaUrl,
  validateLocalFetchRecipe,
  validateRedirectLocation,
  validateUploadTarget,
} from '../../../src/video-summary/media-policy.mjs'

const bilibiliUrl = 'https://upos-sz-mirrorcos.bilivideo.com/audio'
const youtubeUrl = 'https://rr1---sn.example.googlevideo.com/audio'
const uploadUrl =
  'https://tob-upload-y.volcvod.com/tos-vod-cn-v-fixture/mediakit/upload/local/fixture?Authorization=redacted'

test('canonical duration is finite, positive, and at most three hours', () => {
  for (const value of [NaN, Infinity, -Infinity, 0, -1, 10_800_001]) {
    assert.throws(() => validateCanonicalDuration(value), /VIDEO_MEDIA_DURATION_REJECTED/)
  }
  assert.equal(validateCanonicalDuration(10_800_000), 10_800_000)
})

test('candidate duration permits max of two seconds or one percent', () => {
  assert.equal(validateCandidateDuration(100_000, 102_000), 102_000)
  assert.throws(() => validateCandidateDuration(100_000, 102_001), /VIDEO_MEDIA_DURATION_MISMATCH/)
  assert.equal(validateCandidateDuration(1_000_000, 1_010_000), 1_010_000)
  assert.throws(
    () => validateCandidateDuration(1_000_000, 1_010_001),
    /VIDEO_MEDIA_DURATION_MISMATCH/,
  )
  assert.throws(
    () => validateCandidateDuration(10_800_000, 10_800_001),
    /VIDEO_MEDIA_DURATION_REJECTED/,
  )
})

test('initial media URLs use exact platform CDN suffixes', () => {
  assert.equal(validateInitialMediaUrl({ platform: 'bilibili', url: bilibiliUrl }), bilibiliUrl)
  assert.equal(validateInitialMediaUrl({ platform: 'youtube', url: youtubeUrl }), youtubeUrl)

  for (const [platform, url] of [
    ['bilibili', 'http://cdn.bilivideo.com/audio'],
    ['bilibili', 'https://user:pass@cdn.bilivideo.com/audio'],
    ['bilibili', 'https://cdn.bilivideo.com:8443/audio'],
    ['bilibili', 'https://cdn.bilivideo.com/audio#fragment'],
    ['bilibili', 'https://bilivideo.com.evil.test/audio'],
    ['bilibili', 'https://127.0.0.1/audio'],
    ['youtube', 'https://localhost/audio'],
    ['youtube', bilibiliUrl],
    ['bilibili', youtubeUrl],
  ]) {
    assert.throws(() => validateInitialMediaUrl({ platform, url }), /VIDEO_MEDIA_/)
  }
})

test('local fetch recipe preserves origin metadata but rejects transport fields', () => {
  const recipe = validateLocalFetchRecipe({
    platform: 'youtube',
    recipe: {
      primaryUrl: youtubeUrl,
      backupUrls: [],
      credentialMode: 'omit',
      requiredRequestOrigin: 'https://www.youtube.com/',
    },
  })
  assert.equal(recipe.requiredRequestOrigin, 'https://www.youtube.com/')
  assert.equal('headers' in recipe, false)
  assert.equal(localFetchRequiresUnsupportedHeaders(recipe), false)
  assert.throws(
    () =>
      validateLocalFetchRecipe({
        platform: 'youtube',
        recipe: { ...recipe, headers: { Origin: 'x' } },
      }),
    /VIDEO_MEDIA_LOCAL_HEADERS_UNSUPPORTED/,
  )
  assert.throws(
    () =>
      validateLocalFetchRecipe({ platform: 'youtube', recipe: { ...recipe, range: 'bytes=0-' } }),
    /VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED/,
  )
  assert.equal(localFetchRequiresUnsupportedHeaders({ ...recipe, headers: {} }), true)
})

test('redirects resolve relative locations and revalidate the same CDN family', () => {
  assert.equal(
    validateRedirectLocation({ platform: 'bilibili', currentUrl: bilibiliUrl, location: '/next' }),
    'https://upos-sz-mirrorcos.bilivideo.com/next',
  )
  for (const location of [
    '',
    'http://cdn.bilivideo.com/next',
    'https://user@cdn.bilivideo.com/next',
    'https://cdn.bilivideo.com:444/next',
    youtubeUrl,
  ]) {
    assert.throws(
      () => validateRedirectLocation({ platform: 'bilibili', currentUrl: bilibiliUrl, location }),
      /VIDEO_MEDIA_/,
    )
  }
})

test('upload target accepts only the evidenced exact host and transport contract', () => {
  const target = validateUploadTarget({
    url: uploadUrl,
    fileReference: 'mediakit://fixture',
    method: 'PUT',
    headers: {},
    credentials: 'omit',
    redirect: 'error',
  })
  assert.deepEqual(target, {
    url: uploadUrl,
    fileReference: 'mediakit://fixture',
    method: 'PUT',
    headers: {},
    credentials: 'omit',
    redirect: 'error',
  })
  for (const invalid of [
    { url: uploadUrl.replace('https:', 'http:') },
    { url: uploadUrl.replace('tob-upload-y.', 'user@tob-upload-y.') },
    { url: uploadUrl.replace('.com/', '.com:8443/') },
    { url: uploadUrl.replace('tob-upload-y.volcvod.com', 'other.volcvod.com') },
    { url: 'https://tob-upload-y.volcvod.com/unrelated/fixture?Authorization=redacted' },
    { method: 'POST' },
    { headers: { 'Content-Type': 'audio/mp4' } },
    { credentials: 'include' },
    { redirect: 'follow' },
    { fileReference: 'https://example.invalid/file' },
  ]) {
    assert.throws(() => validateUploadTarget({ ...target, ...invalid }), /VIDEO_MEDIA_UPLOAD_/)
  }
})
