'use strict'

// Run from chatGPTBox after a Chromium build, for example:
// CODEX_NODE_MODULES=C:\\Users\\EthanLi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules node tests/manual/sidepanel-smoke.cjs
if (!process.env.CODEX_NODE_MODULES) {
  throw new Error('CODEX_NODE_MODULES must point to the Playwright dependency directory')
}

const { chromium } = require(`${process.env.CODEX_NODE_MODULES}/playwright`)
const { createServer } = require('node:http')
const { resolve, join } = require('node:path')
const { mkdir, mkdtemp, cp, readFile, writeFile, stat } = require('node:fs/promises')
const assert = require('node:assert/strict')

const SMOKE_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const SMOKE_PNG_DATA_URL = `data:image/png;base64,${SMOKE_PNG_BYTES.toString('base64')}`

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = 'BT /F1 24 Tf 50 700 Td (Native side panel smoke) Tj ET'
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return Buffer.from(pdf)
}

async function startServer() {
  let pdfRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/protected.pdf') {
      pdfRequests += 1
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/pdf',
      })
      response.end(samplePdf())
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<title>Native side panel fixture</title><p>Native side panel fixture</p>')
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'fixture server did not receive a TCP address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get pdfRequests() {
      return pdfRequests
    },
    server,
  }
}

async function makeInstrumentedExtension(source) {
  const extension = await mkdtemp(resolve('test-results/sidepanel-smoke-extension-'))
  await cp(source, extension, { recursive: true })
  const backgroundPath = join(extension, 'background.js')
  const background = await readFile(backgroundPath, 'utf8')
  const instrumentation = `(function () {
  globalThis.__testErrors = []
  globalThis.__testContextMenuInvocations = []
  globalThis.__testSidePanelCalls = []
  const originalError = console.error.bind(console)
  console.error = (...args) => { globalThis.__testErrors.push(args.map(String).join(' ')); originalError(...args) }
  try {
    const originalOpen = chrome.sidePanel.open.bind(chrome.sidePanel)
    chrome.sidePanel.open = function (options) {
      const call = { options, settled: false }
      globalThis.__testSidePanelCalls.push(call)
      let result
      try {
        result = originalOpen(options)
      } catch (error) {
        call.error = String(error)
        throw error
      }
      Promise.resolve(result).then(
        () => { call.settled = true },
        (error) => { call.error = String(error); call.settled = true },
      )
      return result
    }
  } catch (error) {
    globalThis.__testErrors.push('could not instrument chrome.sidePanel.open: ' + String(error))
  }
  globalThis.__testContextMenuListener = null
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== '__testInvokeContextMenu') return undefined
    const listener = globalThis.__testContextMenuListener
    if (typeof listener !== 'function') {
      console.error('test context-menu listener is not captured')
      return false
    }
    globalThis.__testContextMenuInvocations.push({ info: message.info, tab: message.tab || sender?.tab })
    try {
      const result = listener(message.info, message.tab || sender?.tab)
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error('test context-menu callback failed', error))
      }
    } catch (error) {
      console.error('test context-menu callback threw', error)
    }
    return false
  })
  const event = chrome.contextMenus && chrome.contextMenus.onClicked
  if (!event || typeof event.addListener !== 'function') return
  const originalAddListener = event.addListener.bind(event)
  event.addListener = function (listener) {
    globalThis.__testContextMenuListener = listener
    return originalAddListener(listener)
  }
})();
`
  // Chromium's webextension-polyfill wraps the native event and caches the
  // underlying addListener method before the production call. Capture the
  // production callback at its bundled registration site as a test-only aid.
  const capturePattern =
    /([A-Za-z_$][A-Za-z0-9_$]*\.contextMenus\.onClicked\.addListener\()([A-Za-z_$][A-Za-z0-9_$]*)(\))/
  const capturedBackground = background.replace(
    capturePattern,
    '(globalThis.__testContextMenuListener=$2,$1$2$3)',
  )
  assert.notEqual(
    capturedBackground,
    background,
    'could not locate bundled context-menu registration',
  )
  await writeFile(backgroundPath, instrumentation + capturedBackground)
  await writeFile(
    join(extension, 'sidebar-launcher.html'),
    '<!doctype html><button id="open">Open PDF sidebar</button><script src="sidebar-launcher.js"></script>',
  )
  await writeFile(
    join(extension, 'sidebar-launcher.js'),
    `
    const tab = JSON.parse(decodeURIComponent(location.hash.slice(1)))
    document.getElementById('open').onclick = () => chrome.runtime.sendMessage({
      type: '__testInvokeContextMenu', info: {menuItemId: 'ChatGPTBox-MenuopenSidePanel'}, tab
    }).catch(() => {})
  `,
  )
  return extension
}

async function attachTargetEvaluator(cdp, targetId, label) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { flatten: false, targetId })
  let commandId = 0
  async function command(method, params = {}) {
    const id = ++commandId
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        cdp.off('Target.receivedMessageFromTarget', onMessage)
        reject(new Error(`${label} CDP command timed out: ${method}`))
      }, 10000)
      function onMessage(event) {
        if (event.sessionId !== sessionId) return
        const message = JSON.parse(event.message)
        if (message.id !== id) return
        clearTimeout(timer)
        cdp.off('Target.receivedMessageFromTarget', onMessage)
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)))
          return
        }
        resolvePromise(message.result)
      }
      cdp.on('Target.receivedMessageFromTarget', onMessage)
      cdp
        .send('Target.sendMessageToTarget', {
          message: JSON.stringify({ id, method, params }),
          sessionId,
        })
        .catch((error) => {
          clearTimeout(timer)
          cdp.off('Target.receivedMessageFromTarget', onMessage)
          reject(error)
        })
    })
  }
  async function evaluate(expression, options = {}) {
    const result = await command('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
      userGesture: options.userGesture !== false,
    })
    if (result?.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails))
    }
    return result?.result?.value
  }
  return { command, evaluate }
}

async function makeWorkerEvaluator(context, page) {
  const cdp = await context.newCDPSession(page)
  const workerTarget = (await cdp.send('Target.getTargets')).targetInfos.find(
    (target) => target.type === 'service_worker' && target.url.includes('/background.js'),
  )
  assert.ok(workerTarget, 'background service worker CDP target is missing')
  const evaluator = await attachTargetEvaluator(cdp, workerTarget.targetId, 'service worker')
  return { cdp, evaluate: evaluator.evaluate }
}

async function waitForPanel(cdp, extensionId, sidePanelPath, timeout = 15000) {
  const expectedUrl = new URL(sidePanelPath, `chrome-extension://${extensionId}/`).href
  const deadline = Date.now() + timeout
  let targets = []
  while (Date.now() < deadline) {
    targets = (await cdp.send('Target.getTargets')).targetInfos
    const panel = targets.find((target) => target.url === expectedUrl)
    if (panel) return { panel, targets }
    await sleep(100)
  }
  const extensionTargets = targets
    .filter((target) => target.url.startsWith(`chrome-extension://${extensionId}/`))
    .map((target) => ({ type: target.type, url: target.url }))
  throw new Error(
    `native side panel target ${expectedUrl} timed out; extension targets: ${JSON.stringify(
      extensionTargets,
    )}`,
  )
}

async function readSidePanelPath(extension) {
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'))
  const sidePanelPath = manifest.side_panel?.default_path
  assert.equal(typeof sidePanelPath, 'string', 'extension manifest has no side_panel.default_path')
  return sidePanelPath
}

async function waitForWorkerValue(worker, read, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await sleep(100)
  }
  throw new Error(
    `timed out waiting for ${label}: ${JSON.stringify(
      await worker.evaluate(() => ({
        url: location.href,
        captured: typeof globalThis.__testContextMenuListener,
        errors: globalThis.__testErrors,
      })),
    )}`,
  )
}

async function launchFixture(extension, baseUrl) {
  const profile = await mkdtemp(resolve('test-results/sidepanel-smoke-profile-'))
  const context = await chromium.launchPersistentContext(profile, {
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    channel: 'msedge',
    headless: true,
    viewport: { height: 960, width: 1440 },
  })
  const worker =
    context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }))
  const extensionId = new URL(worker.url()).host
  const pdf = await context.newPage()
  await pdf.goto(`${baseUrl}/protected.pdf`)
  await sleep(500)
  await pdf.bringToFront()
  const workerEvaluate = async (expression, options) =>
    worker.evaluate((source) => eval(source), `(${JSON.stringify(expression)})`)
  // Keep the regular worker handle available for non-gesture Chrome API queries.
  const activeTab = await worker.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
  )
  assert.ok(
    activeTab?.id != null && activeTab?.windowId != null,
    'fixture PDF is not an active normal tab',
  )
  const cdpEvaluator = await makeWorkerEvaluator(context, pdf)
  return {
    activeTab,
    context,
    cdp: cdpEvaluator.cdp,
    extensionId,
    pdf,
    profile,
    worker,
    workerEvaluate,
    evaluate: cdpEvaluator.evaluate,
  }
}

async function directTrial(extension, baseUrl, server, sidePanelPath, includeTabId) {
  const fixture = await launchFixture(extension, baseUrl)
  const { activeTab, context, cdp, evaluate, extensionId, pdf } = fixture
  const baselineTabs = await fixture.worker.evaluate(
    async () => (await chrome.tabs.query({})).length,
  )
  const baselineRequests = server.pdfRequests
  const options = includeTabId
    ? { tabId: activeTab.id, windowId: activeTab.windowId }
    : { windowId: activeTab.windowId }
  let callResult
  let callError = null
  try {
    callResult = await evaluate(`chrome.sidePanel.open(${JSON.stringify(options)})`)
  } catch (error) {
    callError = String(error)
  }
  let panel = null
  try {
    panel = (await waitForPanel(cdp, extensionId, sidePanelPath, 3000)).panel
  } catch (error) {
    callError ||= String(error)
  }
  const tabsAfter = await fixture.worker.evaluate(async () => (await chrome.tabs.query({})).length)
  const result = {
    api: 'chrome.sidePanel.open',
    callError,
    callResult,
    includeTabId,
    panelTarget: panel && { type: panel.type, url: panel.url },
    pdfRequestsBefore: baselineRequests,
    pdfRequestsAfter: server.pdfRequests,
    tabsBefore: baselineTabs,
    tabsAfter,
    pdfUrl: pdf.url(),
  }
  await context.close()
  return result
}

async function setImageConfig(worker, baseUrl) {
  await worker.evaluate(
    async (config) => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set(config)
    },
    {
      activeApiModes: ['chatgptApi4o_128k', 'customModel'],
      apiKey: 'native-sidepanel-smoke-key',
      apiMode: null,
      configSchemaVersion: 2,
      customApiModes: [],
      customOpenAIProviders: [],
      customOpenAiApiUrl: baseUrl,
      focusAfterAnswer: false,
      knownApiModeDefaultIds: ['chatgptApi4o_128k', 'customModel'],
      modelName: 'chatgptApi4o_128k',
      preferredLanguage: 'en',
      providerSecrets: { openai: 'native-sidepanel-smoke-key' },
      sessions: [],
      userLanguage: 'en',
    },
  )
}

async function waitForNativePanel(evaluate, timeout = 15000) {
  const deadline = Date.now() + timeout
  let state
  while (Date.now() < deadline) {
    state = await evaluate(`(() => ({
      ready: Boolean(
        document.querySelector('.IndependentPanel') &&
        document.querySelector('.input-box') &&
        document.querySelector('textarea.interact-input')
      ),
      attachButtonCount: document.querySelectorAll('.input-image-button').length,
      url: location.href,
    }))()`)
    if (state?.ready && state.attachButtonCount) return state
    await sleep(100)
  }
  throw new Error(`native side panel did not render the image toolbar: ${JSON.stringify(state)}`)
}

async function inspectNativePanel(evaluate) {
  return evaluate(`(() => {
    const box = document.querySelector('.input-box')
    const button = box?.querySelector('.input-image-button')
    const toolbar = button?.parentElement
    const hint = toolbar?.querySelector('span')
    const chatContainer = document.querySelector('.chat-container')
    const fileInputs = box?.querySelectorAll('input[type="file"]') || []
    const rect = (element) => {
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      return {
        bottom: Math.round(bounds.bottom * 10) / 10,
        height: Math.round(bounds.height * 10) / 10,
        left: Math.round(bounds.left * 10) / 10,
        right: Math.round(bounds.right * 10) / 10,
        top: Math.round(bounds.top * 10) / 10,
        width: Math.round(bounds.width * 10) / 10,
      }
    }
    const visible = (element) => {
      if (!element) return false
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
    }
    const boxRect = rect(box)
    const toolbarRect = rect(toolbar)
    const buttonRect = rect(button)
    const hintRect = rect(hint)
    const viewport = { width: innerWidth, height: innerHeight }
    const escapes = (bounds, container) => Boolean(
      bounds && container && (
        bounds.left < container.left || bounds.right > container.right ||
        bounds.top < container.top || bounds.bottom > container.bottom
      )
    )
    return {
      url: location.href,
      title: document.title,
      viewport: {
        ...viewport,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentScrollHeight: document.documentElement.scrollHeight,
      },
      layout: {
        documentHeightChain: {
          html: rect(document.documentElement),
          body: rect(document.body),
          app: rect(document.querySelector('#app')),
          independentPanel: rect(document.querySelector('.IndependentPanel')),
        },
        chatContainerBounds: rect(chatContainer),
        chatContainerHeightRatio: chatContainer
          ? Math.round((chatContainer.getBoundingClientRect().height / innerHeight) * 1000) / 1000
          : 0,
      },
      inputBox: {
        display: box ? getComputedStyle(box).display : null,
        bounds: boxRect,
        clientWidth: box?.clientWidth || 0,
        scrollWidth: box?.scrollWidth || 0,
        overflowX: box ? getComputedStyle(box).overflowX : null,
      },
      toolbar: {
        bounds: toolbarRect,
        clientWidth: toolbar?.clientWidth || 0,
        scrollWidth: toolbar?.scrollWidth || 0,
        overflowX: toolbar ? getComputedStyle(toolbar).overflowX : null,
        buttonCount: box?.querySelectorAll('.input-image-button').length || 0,
        buttonText: button?.innerText.trim() || '',
        buttonAriaLabel: button?.getAttribute('aria-label') || '',
        buttonVisible: visible(button),
        buttonBounds: buttonRect,
        hintText: hint?.innerText.trim() || '',
        hintVisible: visible(hint),
        hintBounds: hintRect,
      },
      fileInput: {
        count: fileInputs.length,
        accept: fileInputs[0]?.getAttribute('accept') || '',
        multiple: fileInputs[0]?.multiple || false,
        ariaLabel: fileInputs[0]?.getAttribute('aria-label') || '',
      },
      clipping: {
        buttonOutsideToolbar: escapes(buttonRect, toolbarRect),
        hintOutsideToolbar: escapes(hintRect, toolbarRect),
        toolbarOutsideViewport: Boolean(
          (buttonRect && (buttonRect.left < 0 || buttonRect.right > viewport.width || buttonRect.top < 0 || buttonRect.bottom > viewport.height)) ||
          (hintRect && (hintRect.left < 0 || hintRect.right > viewport.width || hintRect.top < 0 || hintRect.bottom > viewport.height))
        ),
        toolbarHorizontalOverflow: Boolean(toolbar && toolbar.scrollWidth > toolbar.clientWidth),
      },
    }
  })()`)
}

async function attachLocalImage(panel, filePath) {
  const { root } = await panel.command('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeId } = await panel.command('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type="file"][aria-label="Attach images"]',
  })
  assert.ok(nodeId, 'native side panel file input is missing from its DOM')
  await panel.command('DOM.setFileInputFiles', { files: [filePath], nodeId })
  const deadline = Date.now() + 10000
  let state
  while (Date.now() < deadline) {
    state = await panel.evaluate(`(() => ({
      previewCount: document.querySelectorAll('.input-box img').length,
      previewSource: document.querySelector('.input-box img')?.getAttribute('src') || '',
    }))()`)
    if (state?.previewCount === 1 && state.previewSource.startsWith('data:image/png;base64,')) {
      return state
    }
    await sleep(100)
  }
  throw new Error(
    `native panel file input did not create an image preview: ${JSON.stringify(state)}`,
  )
}

async function runContextMenuTrial(extension, baseUrl, server, sidePanelPath, trial) {
  const fixture = await launchFixture(extension, baseUrl)
  const { activeTab, context, cdp, extensionId, pdf, worker } = fixture
  try {
    await setImageConfig(worker, baseUrl)
    const launcherUrl = `chrome-extension://${extensionId}/sidebar-launcher.html#${encodeURIComponent(
      JSON.stringify(activeTab),
    )}`
    const launcherReady = context.waitForEvent('page')
    await worker.evaluate(
      async ({ url, windowId }) => chrome.tabs.create({ url, windowId, active: true }),
      { url: launcherUrl, windowId: activeTab.windowId },
    )
    const launcher = await launcherReady
    await launcher.waitForLoadState()
    const activeLauncherTab = await worker.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
    )
    const focusedWindow = await worker.evaluate(async () => chrome.windows.getLastFocused())
    assert.equal(
      activeLauncherTab?.windowId,
      activeTab.windowId,
      'test launcher is not in the PDF tab window',
    )
    assert.equal(
      focusedWindow?.id,
      activeTab.windowId,
      'PDF tab window is not focused for the current-window fallback trial',
    )
    const baselineTabs = await worker.evaluate(async () => (await chrome.tabs.query({})).length)
    const baselineRequests = server.pdfRequests
    const captured = await waitForWorkerValue(
      worker,
      () => worker.evaluate(() => typeof globalThis.__testContextMenuListener === 'function'),
      'production context-menu listener',
    )
    assert.equal(
      captured,
      true,
      'instrumentation did not capture the production context-menu listener',
    )
    let callbackError = null
    try {
      await launcher.evaluate((callbackTab) => {
        document.getElementById('open').onclick = () =>
          chrome.runtime
            .sendMessage({
              type: '__testInvokeContextMenu',
              info: { menuItemId: 'ChatGPTBox-MenuopenSidePanel' },
              tab: callbackTab,
            })
            .catch(() => {})
      }, trial.callbackTab(activeTab))
      await launcher.locator('#open').click()
    } catch (error) {
      callbackError = String(error)
    }
    // Return focus to the fixture PDF tab in the same window before reading
    // the native panel target's DOM.
    await pdf.bringToFront()
    let panel
    try {
      panel = (await waitForPanel(cdp, extensionId, sidePanelPath)).panel
    } catch (error) {
      const diagnostics = await worker.evaluate(async () => ({
        errors: globalThis.__testErrors,
        contextMenuInvocations: globalThis.__testContextMenuInvocations,
        sidePanelCalls: globalThis.__testSidePanelCalls,
        capturedCallback: typeof globalThis.__testContextMenuListener,
        activeTabs: await chrome.tabs.query({ active: true, currentWindow: true }),
        focusedWindow: await chrome.windows.getLastFocused(),
        pdfSidePanelOptions: await chrome.sidePanel
          .getOptions({ tabId: globalThis.__testContextMenuInvocations.at(-1)?.tab?.id })
          .catch((error) => ({ error: String(error) })),
      }))
      throw new Error(`${error.message}; callback diagnostics: ${JSON.stringify(diagnostics)}`)
    }
    const panelEvaluator = await attachTargetEvaluator(cdp, panel.targetId, 'native side panel')
    await waitForNativePanel(panelEvaluator.evaluate)
    const sidePanelCall = await worker.evaluate(() => globalThis.__testSidePanelCalls.at(-1))
    assert.deepEqual(
      sidePanelCall?.options,
      { windowId: -2 },
      'missing tab.windowId should open the current window panel',
    )
    assert.equal(sidePanelCall?.settled, true, 'chrome.sidePanel.open did not settle')
    assert.equal(sidePanelCall?.error, undefined, 'chrome.sidePanel.open rejected')
    const callbackErrors = await worker.evaluate(() => globalThis.__testErrors)
    assert.deepEqual(callbackErrors, [], `background callback errors: ${callbackErrors.join('; ')}`)
    const panelDom = await inspectNativePanel(panelEvaluator.evaluate)
    console.log(`${trial.name} native panel DOM:`, JSON.stringify(panelDom))
    assert.equal(
      panelDom.toolbar.buttonCount,
      1,
      'native side panel Attach images toolbar is missing',
    )
    assert.equal(panelDom.toolbar.buttonText, 'Attach images')
    assert.equal(
      panelDom.toolbar.buttonVisible,
      true,
      'native side panel Attach images button is hidden',
    )
    assert.equal(panelDom.toolbar.hintText, 'Drop images here or paste a screenshot')
    assert.equal(panelDom.toolbar.hintVisible, true, 'native side panel image hint is hidden')
    assert.equal(panelDom.fileInput.count, 1, 'native side panel image file input is missing')
    assert.equal(
      panelDom.fileInput.multiple,
      true,
      'native side panel file input does not allow multiple files',
    )
    assert.equal(
      panelDom.inputBox.display,
      'contents',
      'native input box is expected to use display: contents',
    )
    assert.equal(
      panelDom.clipping.buttonOutsideToolbar,
      false,
      'Attach images button escapes its toolbar',
    )
    assert.equal(panelDom.clipping.hintOutsideToolbar, false, 'image hint escapes its toolbar')
    assert.equal(
      panelDom.clipping.toolbarOutsideViewport,
      false,
      'image toolbar is clipped by the panel viewport',
    )
    assert.equal(
      panelDom.clipping.toolbarHorizontalOverflow,
      false,
      'image toolbar overflows horizontally',
    )
    assert.ok(
      panelDom.layout.chatContainerHeightRatio >= 0.9,
      `native side panel chat container uses only ${panelDom.layout.chatContainerHeightRatio} of the viewport height`,
    )
    const screenshotPath = resolve('test-results/sidebar2-native.png')
    const screenshot = await panelEvaluator.command('Page.captureScreenshot', {
      captureBeyondViewport: false,
      format: 'png',
      fromSurface: true,
    })
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    const imagePath = join(fixture.profile, 'native-sidepanel-smoke.png')
    await writeFile(imagePath, SMOKE_PNG_BYTES)
    const fileState = await attachLocalImage(panelEvaluator, imagePath)
    assert.equal(fileState.previewSource, SMOKE_PNG_DATA_URL)
    console.log(`${trial.name} native panel file input:`, JSON.stringify(fileState))
    const tabsAfter = await worker.evaluate(async () => (await chrome.tabs.query({})).length)
    const result = {
      api: 'captured production contextMenus.onClicked callback',
      callbackError,
      panelTarget: { type: panel.type, url: panel.url },
      callbackTab: trial.callbackTab(activeTab),
      sidePanelCall,
      pdfRequestsBefore: baselineRequests,
      pdfRequestsAfter: server.pdfRequests,
      tabsBefore: baselineTabs,
      tabsAfter,
      pdfUrl: pdf.url(),
    }
    assert.equal(callbackError, null, 'production context-menu callback threw or rejected')
    assert.equal(
      result.panelTarget.url,
      new URL(sidePanelPath, `chrome-extension://${extensionId}/`).href,
    )
    assert.equal(result.tabsAfter, baselineTabs, 'native panel must not create a browser tab')
    assert.equal(
      result.pdfRequestsAfter,
      baselineRequests,
      'opening sidebar must not refetch protected PDF',
    )
    assert.equal(result.pdfUrl, `${baseUrl}/protected.pdf`, 'original PDF stays open')
    return result
  } finally {
    await context.close()
  }
}

async function run() {
  await mkdir('test-results', { recursive: true })
  const source = resolve(process.env.CODEX_EXTENSION || 'build/chromium')
  await stat(source)
  const extension = await makeInstrumentedExtension(source)
  const sidePanelPath = await readSidePanelPath(extension)
  const server = await startServer()
  try {
    // A real click is required; DevTools userGesture on a service worker does
    // not create the extension API gesture token in Edge. Use a regular
    // extension tab in the PDF window so the empty-tab fallback tests the
    // actual current window that contains the PDF.
    const trials = [
      {
        name: 'current-window fallback callback',
        callbackTab: () => ({}),
      },
      {
        name: 'tab-id-only current-window fallback callback',
        callbackTab: (activeTab) => ({ id: activeTab.id }),
      },
    ]
    const results = []
    for (const trial of trials) {
      const result = await runContextMenuTrial(
        extension,
        server.baseUrl,
        server,
        sidePanelPath,
        trial,
      )
      results.push(result)
      console.log('CONTEXT MENU production callback:', JSON.stringify(result))
    }
    console.log(
      'PASS: native Edge side panel opened from captured production context-menu callbacks with tab.id-only and empty tab objects; Attach images toolbar, hint, file input preview, viewport clipping, no extra production tab, and no protected PDF refetch verified; screenshot: test-results/sidebar2-native.png.',
    )
  } finally {
    await new Promise((resolvePromise) => server.server.close(resolvePromise))
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
