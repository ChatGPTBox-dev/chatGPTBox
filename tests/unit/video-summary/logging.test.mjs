import assert from 'node:assert/strict'
import test from 'node:test'
import {
  logPipelineEvent,
  projectVideoSummaryLogEntry,
  serializePipelineError,
} from '../../../src/video-summary/logging.mjs'

const sentinels = [
  'SECRET_PROVIDER_BODY',
  'SECRET_PROVIDER_MESSAGE',
  'SECRET_SIGNED_QUERY',
  'SECRET_UPLOAD_REFERENCE',
  'SECRET_PROMPT',
  'SECRET_QUESTION',
  'SECRET_ANSWER',
  'SECRET_TRANSCRIPT',
  'SECRET_SUBTITLE',
  'SECRET_AUTHORIZATION',
  'SECRET_API_KEY',
  'SECRET_TOKEN',
  'SECRET_COOKIE',
  'SECRET_NESTED',
  'SECRET_ERROR_MESSAGE',
]

function createSensitiveFixture() {
  const fixture = {
    event: 'video-summary.media.retry',
    operation: 'submitDirectAsr',
    code: 'VIDEO_SUMMARY_FETCH_FAILED',
    providerCode: 'DOWNLOAD_FAILED',
    httpStatus: 503,
    requestId: 'req_123-abc',
    retryable: true,
    providerBody: 'SECRET_PROVIDER_BODY',
    message: 'SECRET_PROVIDER_MESSAGE',
    url: 'https://media.example/audio?SECRET_SIGNED_QUERY',
    uploadReference: 'SECRET_UPLOAD_REFERENCE',
    prompt: 'SECRET_PROMPT',
    question: 'SECRET_QUESTION',
    answer: 'SECRET_ANSWER',
    transcript: 'SECRET_TRANSCRIPT',
    subtitle: 'SECRET_SUBTITLE',
    Authorization: 'SECRET_AUTHORIZATION',
    apiKey: 'SECRET_API_KEY',
    token: 'SECRET_TOKEN',
    cookie: 'SECRET_COOKIE',
    unknown: { nested: 'SECRET_NESTED' },
    error: new Error('SECRET_ERROR_MESSAGE'),
  }
  fixture.unknown.circular = fixture
  return fixture
}

function assertNoSentinels(value) {
  const serialized = JSON.stringify(value)
  for (const sentinel of sentinels) assert.equal(serialized.includes(sentinel), false, sentinel)
}

test('projects only valid video-summary diagnostic fields', () => {
  assert.deepEqual(projectVideoSummaryLogEntry(createSensitiveFixture()), {
    event: 'video-summary.media.retry',
    operation: 'submitDirectAsr',
    code: 'VIDEO_SUMMARY_FETCH_FAILED',
    providerCode: 'DOWNLOAD_FAILED',
    httpStatus: 503,
    requestId: 'req_123-abc',
    retryable: true,
  })
})

test('omits invalid and unbounded diagnostic values', () => {
  assert.deepEqual(
    projectVideoSummaryLogEntry({
      event: `video-summary.${'a'.repeat(200)}`,
      operation: 'unknownOperation',
      code: 'lowercase code',
      providerCode: `${'A'.repeat(97)}`,
      httpStatus: 503.5,
      requestId: 'contains space',
      retryable: 'true',
      refreshed: 1,
      uploaded: null,
    }),
    {},
  )
})

test('serializePipelineError returns the same strict allowlist projection', () => {
  const error = Object.assign(new Error('SECRET_ERROR_MESSAGE'), createSensitiveFixture())
  const serialized = serializePipelineError(error)

  assert.deepEqual(serialized, {
    operation: 'submitDirectAsr',
    code: 'VIDEO_SUMMARY_FETCH_FAILED',
    providerCode: 'DOWNLOAD_FAILED',
    httpStatus: 503,
    requestId: 'req_123-abc',
    retryable: true,
  })
  assertNoSentinels(serialized)
})

test('logPipelineEvent projects entries and accepts only safe levels', () => {
  const entries = []
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (entry) => entries.push([level, entry]),
    ]),
  )
  const fixture = createSensitiveFixture()

  for (const level of ['debug', 'info', 'warn', 'error']) logPipelineEvent(logger, level, fixture)

  assert.deepEqual(
    entries.map(([level]) => level),
    ['info', 'warn', 'error'],
  )
  for (const [, entry] of entries) {
    assert.deepEqual(entry, projectVideoSummaryLogEntry(fixture))
    assertNoSentinels(entry)
  }
})
