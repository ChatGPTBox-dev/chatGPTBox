import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticateVideoSummaryContentPort,
  authenticateVideoSummaryOffscreenPort,
} from '../../../src/background/video-summary-port-auth.mjs'

const runtime = {
  id: 'extension-id',
  getURL(path) {
    return `chrome-extension://extension-id/${path}`
  },
}
const bilibiliIdentity = {
  platform: 'bilibili',
  videoId: 'BV1auth',
  mediaId: '101',
}
const validContentSender = {
  id: 'extension-id',
  tab: { id: 7 },
  documentId: 'doc-7',
  frameId: 0,
  url: 'https://www.bilibili.com/video/BV1auth?p=1',
}

function contentPort(sender = validContentSender) {
  return { name: 'video-summary', sender }
}

test('content authentication derives owner from browser sender and page identity', () => {
  assert.deepEqual(
    authenticateVideoSummaryContentPort({
      port: contentPort(),
      runtime,
      pageIdentity: bilibiliIdentity,
    }),
    {
      tabId: 7,
      documentId: 'doc-7',
      frameId: 0,
      pageIdentity: bilibiliIdentity,
      owner: { tabId: 7, documentId: 'doc-7', platform: 'bilibili', mediaId: '101' },
    },
  )
})

test('content authentication trims document identity', () => {
  const authenticated = authenticateVideoSummaryContentPort({
    port: contentPort({ ...validContentSender, documentId: ' doc-7 ' }),
    runtime,
    pageIdentity: bilibiliIdentity,
  })

  assert.equal(authenticated.documentId, 'doc-7')
  assert.equal(authenticated.owner.documentId, 'doc-7')
})

test('content authentication rejects every forged browser context', () => {
  const invalidSenders = [
    { ...validContentSender, id: 'other-extension' },
    { ...validContentSender, tab: undefined },
    { ...validContentSender, tab: { id: 1.5 } },
    { ...validContentSender, documentId: '' },
    { ...validContentSender, documentId: '   ' },
    { ...validContentSender, frameId: undefined },
    { ...validContentSender, frameId: 1 },
    { ...validContentSender, url: undefined, origin: 'https://www.bilibili.com' },
    { ...validContentSender, url: 'http://www.bilibili.com/video/BV1auth' },
    { ...validContentSender, url: 'https://evil.example/video/BV1auth' },
  ]
  for (const sender of invalidSenders) {
    assert.throws(
      () =>
        authenticateVideoSummaryContentPort({
          port: contentPort(sender),
          runtime,
          pageIdentity: bilibiliIdentity,
        }),
      /VIDEO_SUMMARY_CONTENT_PORT_UNAUTHORIZED/,
    )
  }
})

test('content platform must match exact allowed origin', () => {
  assert.throws(
    () =>
      authenticateVideoSummaryContentPort({
        port: contentPort(),
        runtime,
        pageIdentity: {
          platform: 'youtube',
          videoId: 'abcdefghijk',
          mediaId: 'abcdefghijk',
        },
      }),
    /VIDEO_SUMMARY_CONTENT_PORT_UNAUTHORIZED/,
  )
  assert.doesNotThrow(() =>
    authenticateVideoSummaryContentPort({
      port: contentPort({
        ...validContentSender,
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
      }),
      runtime,
      pageIdentity: {
        platform: 'youtube',
        videoId: 'abcdefghijk',
        mediaId: 'abcdefghijk',
      },
    }),
  )
})

test('offscreen authentication requires exact extension document identity', () => {
  const valid = {
    name: 'video-summary-offscreen',
    sender: {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/VideoSummaryOffscreen.html',
    },
  }
  assert.deepEqual(authenticateVideoSummaryOffscreenPort({ port: valid, runtime }), {
    documentUrl: runtime.getURL('VideoSummaryOffscreen.html'),
  })
  for (const sender of [
    { ...valid.sender, id: 'other-extension' },
    { ...valid.sender, tab: { id: 7 } },
    { ...valid.sender, url: 'chrome-extension://extension-id/popup.html' },
    { ...valid.sender, url: 'https://www.bilibili.com/' },
    { id: 'extension-id', origin: 'chrome-extension://extension-id' },
  ]) {
    assert.throws(
      () => authenticateVideoSummaryOffscreenPort({ port: { ...valid, sender }, runtime }),
      /VIDEO_SUMMARY_OFFSCREEN_PORT_UNAUTHORIZED/,
    )
  }
})
