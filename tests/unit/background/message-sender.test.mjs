import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import Browser from 'webextension-polyfill'
import { isTrustedExtensionSender } from '../../../src/background/message-sender.mjs'

const EXTENSION_PAGE_URL = `${Browser.runtime.getURL('/')}popup.html`

describe('isTrustedExtensionSender', () => {
  test('accepts this extension, including its content scripts on a web page', () => {
    assert.equal(isTrustedExtensionSender({ id: Browser.runtime.id }), true)
    assert.equal(
      isTrustedExtensionSender({ id: Browser.runtime.id, url: 'https://example.com/article' }),
      true,
    )
  })

  test('accepts an extension page that reports no id', () => {
    assert.equal(isTrustedExtensionSender({ url: EXTENSION_PAGE_URL }), true)
    assert.equal(isTrustedExtensionSender({ documentUrl: EXTENSION_PAGE_URL }), true)
  })

  test('rejects web pages, other extensions and empty senders', () => {
    assert.equal(isTrustedExtensionSender({ url: 'https://example.com/article' }), false)
    assert.equal(isTrustedExtensionSender({ id: 'another-extension' }), false)
    assert.equal(
      isTrustedExtensionSender({ url: 'chrome-extension://another-id/popup.html' }),
      false,
    )
    assert.equal(isTrustedExtensionSender({}), false)
    assert.equal(isTrustedExtensionSender(undefined), false)
  })
})
