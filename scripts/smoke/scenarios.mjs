import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { bounded, waitFor } from './lifecycle.mjs'
import { startMockServer } from './mock-server.mjs'

export function assertPopupIdentity(identity, metadata) {
  assert.ok(metadata.expectedName, 'Adapter metadata must include expectedName')
  assert.ok(metadata.expectedVersion, 'Adapter metadata must include expectedVersion')
  assert.ok(metadata.extensionId, 'Adapter metadata must include the installed extensionId')
  assert.ok(metadata.popupUrl, 'Adapter metadata must include the installed popupUrl')
  assert.equal(identity.visible, true, 'Installed popup tabs must be visible')
  assert.equal(
    identity.extensionId,
    metadata.extensionId,
    'Runtime identity must match installation',
  )
  assert.equal(
    identity.name,
    metadata.expectedName,
    'Runtime name must match the installed manifest',
  )
  assert.equal(
    identity.version,
    metadata.expectedVersion,
    'Runtime version must match the installed manifest',
  )
  assert.equal(
    identity.location,
    identity.popupUrl,
    'The evaluated page must be the manifest popup',
  )
  assert.equal(identity.popupUrl, metadata.popupUrl)
}

export function assertScenarioMessages(messages, { phase, question, history = [] }) {
  const errors = messages.filter((message) => message.error)
  const done = messages.filter((message) => message.done === true)
  const answers = messages.filter((message) => message.answer != null)
  const acknowledgements = messages.filter((message) => message.session && message.done !== true)
  assert.equal(
    acknowledgements.length,
    1,
    'The background must acknowledge the initial session once',
  )
  const acknowledgement = acknowledgements[0]
  assert.equal(acknowledgement.answer == null && !acknowledgement.error, true)
  assert.deepEqual(
    acknowledgement.session.conversationRecords,
    history,
    'The initial acknowledgement must preserve history',
  )
  assert.ok(
    messages.indexOf(acknowledgement) <
      messages.findIndex((message) => message.answer != null || message.error),
    'The initial acknowledgement must precede the first answer or error',
  )
  if (phase === 'error') {
    assert.equal(errors.length, 1, 'HTTP failure must emit one error')
    assert.match(String(errors[0].error), /smoke_503|Smoke upstream unavailable/)
    assert.equal(done.length, 0, 'HTTP failure must not complete successfully')
    assert.equal(answers.length, 0, 'HTTP failure must not emit an answer')
    return
  }
  assert.equal(errors.length, 0, 'Successful stream must not emit errors')
  if (phase === 'partial') {
    assert.equal(done.length, 0, 'The gated stream must still be live')
    assert.deepEqual(
      answers.map(({ answer }) => answer),
      ['Hello '],
      'The browser must observe exactly the first delta',
    )
    return
  }
  assert.equal(phase, 'final')
  assert.equal(done.length, 1, 'The stream must complete exactly once')
  // Mock content events, not network chunks, determine the cumulative answers.
  assert.deepEqual(
    answers.map(({ answer }) => answer),
    ['Hello ', 'Hello 世界🙂'],
    'Every cumulative answer must match the mock stream exactly once and in order',
  )
  assert.equal(done[0].answer, null, 'Completion must not carry answer content')
  assert.ok(
    messages.indexOf(done[0]) > messages.indexOf(answers.at(-1)),
    'Completion must follow every answer',
  )
  assert.deepEqual(
    done[0].session?.conversationRecords,
    [...history, { question, answer: 'Hello 世界🙂' }],
    'The stream must add exactly one complete history record',
  )
}

// These functions are serialized into the installed popup and must remain self-contained.
function popupIdentity() {
  const api = globalThis.browser || globalThis.chrome
  if (!api?.runtime?.id) throw new Error('Missing extension runtime in popup')
  const manifest = api.runtime.getManifest()
  const visible = [...document.querySelectorAll('#app [role="tab"]')].some((tab) => {
    const style = globalThis.getComputedStyle(tab)
    return (
      [...tab.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0) &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    )
  })
  return {
    visible,
    extensionId: api.runtime.id,
    name: manifest.name,
    version: manifest.version,
    popupUrl: api.runtime.getURL(
      manifest.action?.default_popup || manifest.browser_action?.default_popup,
    ),
    location: globalThis.location.href,
  }
}

async function configure(baseUrl) {
  const api = globalThis.browser || globalThis.chrome
  await api.storage.local.set({
    preferredLanguage: 'en',
    customOpenAIProviders: ['success', 'error'].map((name) => ({
      id: `smoke-${name}`,
      name: `Smoke ${name}`,
      baseUrl: `${baseUrl}/${name}/v1`,
      chatCompletionsPath: '/chat/completions',
      enabled: true,
    })),
    providerSecrets: {
      'smoke-success': 'smoke-local-only',
      'smoke-error': 'smoke-local-only',
    },
    maxConversationContextLength: 4,
    maxResponseTokenLength: 64,
    temperatureOverrideEnabled: false,
  })
}

export function beginRequest(key, question, history) {
  const api = globalThis.browser || globalThis.chrome
  const state = (window.__chatGPTBoxSmoke ??= {})
  if (state[key]) throw new Error(`Smoke request already started: ${key}`)
  const port = api.runtime.connect({ name: `smoke-${key}` })
  const request = (state[key] = { port, messages: [], disconnected: false })
  port.onMessage.addListener((message) => request.messages.push(message))
  port.onDisconnect.addListener(() => {
    request.disconnected = true
    request.disconnectError = api.runtime.lastError?.message || 'Unexpected port disconnect'
  })
  port.postMessage({
    session: {
      question,
      modelName: 'customModel',
      conversationRecords: history,
      isRetry: false,
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: `Smoke ${key}`,
        isCustom: true,
        providerId: `smoke-${key}`,
        customName: 'smoke-model',
        customUrl: '',
        apiKey: '',
        active: true,
      },
    },
  })
}

export function snapshot(key) {
  const request = window.__chatGPTBoxSmoke?.[key]
  if (!request) throw new Error(`Missing smoke request: ${key}`)
  if (request.disconnected) throw new Error(request.disconnectError)
  return request.messages
}

export function disconnectPorts() {
  const state = window.__chatGPTBoxSmoke
  if (!state) return
  const errors = []
  try {
    for (const request of Object.values(state)) {
      try {
        request.port.disconnect()
      } catch (error) {
        errors.push(error)
      }
    }
  } finally {
    delete window.__chatGPTBoxSmoke
  }
  if (errors.length) throw new AggregateError(errors, 'Failed to disconnect smoke ports')
}

export async function runScenarios(adapter, { lifecycle, signal, checks = [] }) {
  const evaluate = (fn, ...args) => {
    signal?.throwIfAborted()
    return bounded(adapter.evaluate(fn, ...args), 10000, `popup ${fn.name}`, signal)
  }
  const identity = await waitFor(
    async () => {
      const value = await evaluate(popupIdentity)
      return value.visible && value
    },
    { signal, label: 'visible installed popup tabs' },
  )
  assertPopupIdentity(identity, adapter.metadata)
  checks.push('Installed popup visible with matching runtime identity and version')

  const mock = await startMockServer({ lifecycle, signal })
  let disconnected = false
  let disconnecting
  const disconnect = async () => {
    if (disconnected) return
    if (disconnecting) return disconnecting
    disconnecting = bounded(
      Promise.resolve().then(() => adapter.evaluateCleanup(disconnectPorts)),
      5000,
      'disconnect smoke ports',
    )
    try {
      await disconnecting
      disconnected = true
    } finally {
      disconnecting = undefined
    }
  }
  lifecycle.defer('smoke runtime ports', disconnect)
  let primaryError
  try {
    await evaluate(configure, mock.baseUrl)
    const question = 'Smoke success question'
    await evaluate(beginRequest, 'success', question, [])
    const partial = await waitFor(
      async () => {
        const messages = await evaluate(snapshot, 'success')
        if (messages.some((message) => message.error || message.done)) {
          assertScenarioMessages(messages, { phase: 'partial', question })
        }
        return messages.some((message) => typeof message.answer === 'string') && messages
      },
      { signal, label: 'first streamed answer before release' },
    )
    assertScenarioMessages(partial, { phase: 'partial', question })
    checks.push('Partial Hello answer observed while the SSE response remains gated')
    mock.release()
    await waitFor(
      async () => {
        const messages = await evaluate(snapshot, 'success')
        assert.equal(messages.filter((message) => message.error).length, 0)
        return messages.some((message) => message.done)
      },
      { signal, label: 'completed streamed answer' },
    )
    const history = [{ question, answer: 'Hello 世界🙂' }]
    await evaluate(beginRequest, 'error', 'Smoke error question', history)
    await waitFor(
      async () => {
        const messages = await evaluate(snapshot, 'error')
        assert.equal(messages.filter((message) => message.done).length, 0)
        return messages.some((message) => message.error)
      },
      { signal, label: 'HTTP 503 error from background' },
    )
    // Keep both ports open through the error round and a short drain window to catch late done messages.
    await delay(150, undefined, { signal })
    assertScenarioMessages(await evaluate(snapshot, 'success'), { phase: 'final', question })
    checks.push('Exact Unicode answer, one completion, and one conversation record')
    assertScenarioMessages(await evaluate(snapshot, 'error'), { phase: 'error', history })
    checks.push('HTTP 503 reported without completion or a new conversation record')
    assert.equal(mock.requests.length, 2, 'Each scenario must issue exactly one HTTP request')
    assert.deepEqual(
      mock.requests.map(({ status }) => status),
      [200, 503],
    )
    assert.deepEqual(mock.requests[0].body.messages, [{ role: 'user', content: question }])
    assert.deepEqual(mock.requests[1].body.messages, [
      { role: 'user', content: question },
      { role: 'assistant', content: 'Hello 世界🙂' },
      { role: 'user', content: 'Smoke error question' },
    ])
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error), { cause: error })
  }
  const cleanupErrors = []
  for (const cleanup of [disconnect, () => mock.close()]) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error : new Error(String(error), { cause: error }),
      )
    }
  }
  if (primaryError) {
    if (cleanupErrors.length) {
      primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), ...cleanupErrors]
    }
    throw primaryError
  }
  if (cleanupErrors.length) {
    const error = new AggregateError(cleanupErrors, 'Smoke scenario cleanup failed')
    error.cleanupErrors = cleanupErrors
    throw error
  }
  return { checks, requests: mock.requests }
}
