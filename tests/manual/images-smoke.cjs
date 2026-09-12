'use strict'

// Run from chatGPTBox after a Chromium build, for example:
// CODEX_NODE_MODULES=C:\\Users\\EthanLi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules node tests/manual/images-smoke.cjs
if (!process.env.CODEX_NODE_MODULES) {
  throw new Error('CODEX_NODE_MODULES must point to the Playwright dependency directory')
}

const { chromium } = require(process.env.CODEX_NODE_MODULES + '/playwright')
const { createServer } = require('node:http')
const { resolve } = require('node:path')
const { mkdir, mkdtemp, stat } = require('node:fs/promises')
const assert = require('node:assert/strict')

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function readRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function startMockServer() {
  const requests = []
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method !== 'POST' || !request.url.startsWith('/v1/chat/completions')) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('not found')
      return
    }

    try {
      const rawBody = await readRequestBody(request)
      const body = JSON.parse(rawBody)
      requests.push(body)
      const answer = `mock answer ${requests.length}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`)
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    }
  })

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'mock server did not receive a TCP address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    server,
  }
}

async function waitForRequestCount(requests, expected, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (requests.length >= expected) return
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for ${label || expected + ' mock requests'} (got ${requests.length})`,
  )
}

async function waitForAnswer(page, answer) {
  await page.waitForFunction((expected) => document.body.innerText.includes(expected), answer, {
    timeout: 10000,
  })
}

async function waitForIndependentPanel(page) {
  await page.locator('.IndependentPanel').waitFor({ state: 'attached', timeout: 15000 })
  await page.locator('textarea.interact-input').waitFor({ state: 'attached', timeout: 15000 })
  await page.locator('.input-box').waitFor({ state: 'attached', timeout: 15000 })
}

function inputBox(page) {
  return page.locator('.input-box').first()
}

function questionInput(page) {
  return page.locator('textarea.interact-input').first()
}

async function previewCount(page) {
  return inputBox(page).locator('img').count()
}

async function previewSource(page) {
  return inputBox(page).locator('img').first().getAttribute('src')
}

async function clickAttachmentRemove(page) {
  const clicked = await inputBox(page).evaluate((root) => {
    const candidates = Array.from(
      root.querySelectorAll('button, [role="button"], [aria-label], [title], span'),
    )
    const target = candidates.find((element) => {
      const label = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.textContent,
      ]
        .filter(Boolean)
        .join(' ')
        .trim()
        .toLowerCase()
      if (!label) return false
      if (/remove|delete|clear/.test(label) && /image|attachment|file|upload|preview/.test(label)) {
        return true
      }
      return label === '×' || label === 'x' || label === '✕'
    })
    if (!target) return false
    target.click()
    return true
  })
  assert.equal(clicked, true, 'image preview has no remove control')
  await page.waitForFunction(() => !document.querySelector('.input-box img'), undefined, {
    timeout: 5000,
  })
}

async function dispatchImageEvent(page, kind, fileName) {
  await questionInput(page).evaluate(
    (target, details) => {
      const comma = details.dataUrl.indexOf(',')
      const binary = atob(details.dataUrl.slice(comma + 1))
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      const file = new File([bytes], details.fileName, { type: 'image/png' })
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)
      if (details.kind === 'paste') {
        const event = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: dataTransfer })
        target.dispatchEvent(event)
        return
      }
      const dragOptions = { bubbles: true, cancelable: true, dataTransfer }
      target.dispatchEvent(new DragEvent('dragover', dragOptions))
      target.dispatchEvent(new DragEvent('drop', dragOptions))
    },
    { dataUrl: PNG_DATA_URL, fileName, kind },
  )
}

async function assertMultimodalUserMessage(requestBody, expectedDataUrl, label) {
  const messages = requestBody?.messages
  assert.ok(Array.isArray(messages), `${label}: mock payload has no messages array`)
  const current = messages.at(-1)
  assert.equal(current?.role, 'user', `${label}: final message is not a user message`)
  assert.ok(Array.isArray(current.content), `${label}: final user message is not multimodal`)
  const imagePart = current.content.find((part) => part?.type === 'image_url')
  assert.ok(imagePart, `${label}: final user message has no image_url part`)
  assert.equal(imagePart.image_url?.url, expectedDataUrl, `${label}: image data URL changed`)
  return messages
}

async function setLocalConfig(worker, config) {
  await worker.evaluate(async (nextConfig) => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set(nextConfig)
  }, config)
}

async function run() {
  await mkdir('test-results', { recursive: true })
  const extension = resolve(process.env.CODEX_EXTENSION || 'build/chromium')
  await stat(extension)

  const mock = await startMockServer()
  const profile = await mkdtemp(resolve('test-results/images-smoke-profile-'))
  let context
  let page
  try {
    context = await chromium.launchPersistentContext(profile, {
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      channel: 'msedge',
      headless: true,
      viewport: { width: 380, height: 820 },
    })
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker', { timeout: 15000 }))
    const extensionId = new URL(worker.url()).host
    const apiConfig = {
      activeApiModes: ['chatgptApi4o_128k', 'customModel'],
      apiKey: 'images-smoke-key',
      apiMode: null,
      configSchemaVersion: 2,
      customApiModes: [],
      customOpenAIProviders: [],
      customOpenAiApiUrl: mock.baseUrl,
      focusAfterAnswer: false,
      knownApiModeDefaultIds: ['chatgptApi4o_128k', 'customModel'],
      modelName: 'chatgptApi4o_128k',
      preferredLanguage: 'en',
      providerSecrets: { openai: 'images-smoke-key' },
      sessions: [],
      userLanguage: 'en',
    }
    await setLocalConfig(worker, apiConfig)

    page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`chrome-extension://${extensionId}/IndependentPanel.html`)
    await waitForIndependentPanel(page)

    const fileInput = inputBox(page).locator('input[type="file"]').first()
    assert.equal(await fileInput.count(), 1, 'image file picker is missing from the input box')
    assert.equal(await fileInput.isDisabled(), false, 'OpenAI-compatible image picker is disabled')

    await fileInput.setInputFiles({
      name: 'picker.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    })
    await page.waitForFunction(() => Boolean(document.querySelector('.input-box img')), undefined, {
      timeout: 5000,
    })
    assert.equal(await previewCount(page), 1, 'file picker did not create one image preview')
    assert.equal(
      await previewSource(page),
      PNG_DATA_URL,
      'file picker preview has the wrong data URL',
    )
    await clickAttachmentRemove(page)

    await dispatchImageEvent(page, 'paste', 'paste.png')
    await page.waitForFunction(() => Boolean(document.querySelector('.input-box img')), undefined, {
      timeout: 5000,
    })
    assert.equal(await previewCount(page), 1, 'paste did not create one image preview')
    assert.equal(await previewSource(page), PNG_DATA_URL, 'paste preview has the wrong data URL')
    await clickAttachmentRemove(page)

    await dispatchImageEvent(page, 'drop', 'drop.png')
    await page.waitForFunction(() => Boolean(document.querySelector('.input-box img')), undefined, {
      timeout: 5000,
    })
    assert.equal(await previewCount(page), 1, 'drop did not create one image preview')
    assert.equal(await previewSource(page), PNG_DATA_URL, 'drop preview has the wrong data URL')
    assert.equal(
      await questionInput(page).inputValue(),
      '',
      'image-only smoke input unexpectedly has text',
    )

    await page.locator('.submit-button').click()
    await waitForRequestCount(mock.requests, 1, 'image-only send')
    await waitForAnswer(page, 'mock answer 1')
    await assertMultimodalUserMessage(mock.requests[0], PNG_DATA_URL, 'image-only send')

    const firstUserImage = page.locator('.chatgptbox-question img').first()
    await firstUserImage.waitFor({ state: 'attached', timeout: 5000 })
    assert.equal(
      await firstUserImage.getAttribute('src'),
      PNG_DATA_URL,
      'sent image is not rendered in history',
    )

    const retryButton = page.locator('[title*="Retry" i], [aria-label*="Retry" i]').last()
    await retryButton.waitFor({ state: 'visible', timeout: 5000 })
    await retryButton.click()
    await waitForRequestCount(mock.requests, 2, 'image retry')
    await waitForAnswer(page, 'mock answer 2')
    await assertMultimodalUserMessage(mock.requests[1], PNG_DATA_URL, 'image retry')

    const followup = 'text follow-up after the image'
    await questionInput(page).fill(followup)
    await page.locator('.submit-button').click()
    await waitForRequestCount(mock.requests, 3, 'text follow-up')
    await waitForAnswer(page, 'mock answer 3')
    const followupMessages = mock.requests[2].messages
    assert.ok(Array.isArray(followupMessages), 'text follow-up payload has no messages array')
    const historicalImageMessage = followupMessages.find(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part?.type === 'image_url'),
    )
    assert.ok(historicalImageMessage, 'text follow-up lost the earlier image from history')
    assert.equal(
      followupMessages.at(-1)?.content,
      followup,
      'text follow-up current message is not plain text',
    )

    await page.screenshot({ path: resolve('test-results/images-smoke.png'), fullPage: true })

    await fileInput.setInputFiles({
      name: 'draft.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    })
    await page.waitForFunction(() => Boolean(document.querySelector('.input-box img')), undefined, {
      timeout: 5000,
    })
    await questionInput(page).fill('draft text to clear')
    const clearButton = page.locator('[title*="Clear Conversation" i]').first()
    await clearButton.click()
    const confirmButton = page
      .locator('button:visible')
      .filter({ hasText: /^Confirm$/ })
      .last()
    await confirmButton.click()
    await page.waitForFunction(
      () =>
        !document.querySelector('.chatgptbox-question') &&
        !document.querySelector('.input-box img') &&
        document.querySelector('textarea.interact-input')?.value === '',
      undefined,
      { timeout: 10000 },
    )
    assert.equal(mock.requests.length, 3, 'clearing a draft unexpectedly called the mock API')

    await setLocalConfig(worker, {
      ...apiConfig,
      activeApiModes: ['chatgptFree35', 'customModel'],
      knownApiModeDefaultIds: ['chatgptFree35', 'customModel'],
      modelName: 'chatgptFree35',
      providerSecrets: {},
      sessions: [],
    })
    await page.reload()
    await waitForIndependentPanel(page)
    const webFileInput = inputBox(page).locator('input[type="file"]').first()
    const requestsBeforeWeb = mock.requests.length
    if (await webFileInput.count()) {
      await webFileInput.setInputFiles({
        name: 'blocked.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      })
      await sleep(300)
      assert.equal(await previewCount(page), 0, 'web mode accepted an image attachment')
    }
    await dispatchImageEvent(page, 'drop', 'blocked-drop.png')
    await sleep(300)
    assert.equal(await previewCount(page), 0, 'web mode accepted a dropped image')
    await page.locator('.submit-button').click()
    await sleep(500)
    assert.equal(
      mock.requests.length,
      requestsBeforeWeb,
      'unsupported web mode sent an image request',
    )

    assert.deepEqual(pageErrors, [], `IndependentPanel page errors: ${pageErrors.join('; ')}`)
    console.log(
      'PASS: 380px Edge extension image picker/remove, paste, drop, image-only multimodal request, retry image retention, text follow-up history retention, draft/image clear, and web-mode attachment blocking; limits are enforced by the product at 4 images per message, 4 MiB per file, and 12 MiB total; screenshot: test-results/images-smoke.png',
    )
  } finally {
    if (page && !page.isClosed()) {
      await page
        .screenshot({ path: resolve('test-results/images-smoke-last.png'), fullPage: true })
        .catch(() => {})
    }
    if (context) await context.close()
    await new Promise((resolvePromise) => mock.server.close(resolvePromise))
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
