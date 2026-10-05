import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

register(
  './tests/setup/content-script-selection-toolbar-loader-hooks.mjs',
  pathToFileURL(cwd() + '/').href,
)

const { buildExportCredentialWarningMessage, getVideoSummaryEnabledUpdate } = await import(
  '../../../src/popup/sections/VideoSummarySettings.jsx'
)

test('export warning explicitly mentions plaintext credentials', () => {
  assert.equal(buildExportCredentialWarningMessage().includes('plaintext API credentials'), true)
})

test('shared video summary switch writes only the canonical field', () => {
  assert.deepEqual(getVideoSummaryEnabledUpdate(true), { videoTranscriptionEnabled: true })
  assert.deepEqual(getVideoSummaryEnabledUpdate(false), { videoTranscriptionEnabled: false })
})
