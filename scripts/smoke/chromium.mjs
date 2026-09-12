import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'
import { connectCDP } from './cdp.mjs'
import { bounded, waitFor } from './lifecycle.mjs'
import { hashArtifact } from './artifacts.mjs'

export async function startChromium({
  executable,
  extensionDir,
  profileDir,
  artifactsDir,
  lifecycle,
  signal,
  artifactSha256,
}) {
  signal?.throwIfAborted()
  extensionDir = await realpath(path.resolve(extensionDir))
  profileDir = path.resolve(profileDir)
  artifactsDir = path.resolve(artifactsDir)
  if (extensionDir.includes(',')) throw new Error('Chromium extension path must not contain commas')
  if (typeof artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifactSha256))
    throw new Error('Missing preflight build hash')
  if ((await hashArtifact(extensionDir, signal)) !== artifactSha256)
    throw new Error('Build changed since preflight')
  const manifest = JSON.parse(
    await readFile(path.join(extensionDir, 'manifest.json'), { encoding: 'utf8', signal }),
  )
  const workerPath = manifest.background?.service_worker
  const popupPath = manifest.action?.default_popup
  if (!workerPath || !popupPath) {
    throw new Error('Chromium build must declare a service worker and an action popup')
  }
  // Linux unpacked IDs use the manifest public key, or the canonical load path.
  // Chromium's components/crx_file/id_util.cc maps the first 128 SHA-256 bits to a-p.
  const extensionId = createHash('sha256')
    .update(manifest.key ? Buffer.from(manifest.key, 'base64') : extensionDir)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  const extensionOrigin = `chrome-extension://${extensionId}/`
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  try {
    await readFile(portFile)
    throw new Error('Chromium profile already contains DevToolsActivePort; use a fresh profile')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  signal?.throwIfAborted()
  const browser = lifecycle.spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      'about:blank',
    ],
    { logPath: path.join(artifactsDir, 'chromium.log') },
  )
  let cdp, sessionId, popupUrl
  const evaluateExpression = async (expression, options) => {
    if (!options?.diagnostic && !options?.cleanup) browser.assertRunning()
    const response = await cdp.request(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      options,
    )
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails
      throw new Error(`Chromium evaluation failed: ${detail.exception?.description ?? detail.text}`)
    }
    if (!response.result) throw new Error('Chromium evaluation returned no result')
    if (response.result.subtype === 'error') {
      throw new Error(`Chromium evaluation returned an Error: ${response.result.description}`)
    }
    return response.result.value
  }
  const evaluate = (fn, ...args) => {
    if (typeof fn !== 'function') throw new TypeError('evaluate requires a function')
    return evaluateExpression(`(${fn.toString()})(...${JSON.stringify(args)})`)
  }
  const evaluateCleanup = async (fn, ...args) => {
    if (typeof fn !== 'function') throw new TypeError('evaluate requires a function')
    const controller = new AbortController()
    try {
      return await evaluateExpression(`(${fn.toString()})(...${JSON.stringify(args)})`, {
        cleanup: true,
        signal: controller.signal,
        timeoutMs: 5000,
      })
    } finally {
      controller.abort()
    }
  }
  const capture = async (prefix) => {
    if (!sessionId) throw new Error('Chromium popup is not attached; capture unavailable')
    // Diagnostic requests have their own short deadlines.
    const options = { signal: undefined, timeoutMs: 2000, diagnostic: true }
    const destination = path.resolve(artifactsDir, prefix)
    if (path.dirname(destination) !== artifactsDir) {
      throw new Error('Capture prefix must name a file inside artifactsDir')
    }
    const results = await Promise.allSettled([
      (async () => {
        const { data } = await cdp.request(
          'Page.captureScreenshot',
          { format: 'png' },
          sessionId,
          options,
        )
        await bounded(
          writeFile(`${destination}.png`, Buffer.from(data, 'base64')),
          2000,
          'Write Chromium screenshot',
        )
      })(),
      (async () => {
        const dom = await evaluateExpression('document.documentElement.outerHTML', options)
        await bounded(writeFile(`${destination}.html`, dom), 2000, 'Write Chromium DOM')
      })(),
    ])
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Chromium capture failed')
  }
  try {
    const endpoint = await waitFor(
      async () => {
        browser.assertRunning()
        let content
        try {
          content = await readFile(portFile, 'utf8')
        } catch (error) {
          if (error.code === 'ENOENT') return false
          throw error
        }
        const [port, websocketPath] = content.trim().split(/\r?\n/)
        // Chromium may still be writing this file; wait for the complete port and UUID.
        if (!port || !websocketPath) return false
        if (
          !/^\d+$/.test(port) ||
          Number(port) < 1 ||
          Number(port) > 65535 ||
          !/^\/devtools\/browser\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
            websocketPath,
          )
        ) {
          return false
        }
        return `ws://127.0.0.1:${port}${websocketPath}`
      },
      { signal, label: 'Complete Chromium DevToolsActivePort record' },
    )
    cdp = await connectCDP(endpoint, { lifecycle, signal })
    const { product: browserVersion } = await cdp.request('Browser.getVersion')
    await waitFor(
      async () => {
        browser.assertRunning()
        const { targetInfos } = await cdp.request('Target.getTargets')
        const workers = targetInfos.filter((target) => {
          if (target.type !== 'service_worker' || !target.url.startsWith('chrome-extension://')) {
            return false
          }
          return target.url === new URL(workerPath, extensionOrigin).href
        })
        if (workers.length > 1)
          throw new Error('Multiple matching Chromium extension service workers')
        return workers[0]
      },
      { signal, label: 'Chromium extension service worker' },
    )
    popupUrl = new URL(popupPath, extensionOrigin).href
    if (!popupUrl.startsWith(extensionOrigin)) throw new Error('Popup must belong to the extension')
    const { targetId } = await cdp.request('Target.createTarget', { url: popupUrl })
    const attached = await cdp.request('Target.attachToTarget', { targetId, flatten: true })
    sessionId = attached.sessionId
    if (!sessionId) throw new Error('Chromium popup attachment returned no session ID')
    await cdp.request('Runtime.enable', {}, sessionId)
    await cdp.request('Page.enable', {}, sessionId)
    await waitFor(
      async () => {
        try {
          return await evaluateExpression(
            `location.href === ${JSON.stringify(popupUrl)} && document.readyState === 'complete'`,
          )
        } catch (error) {
          // Only a read-only readiness probe may retry a navigation context transition.
          if (
            error.code === -32000 &&
            /^Runtime\.evaluate: (Execution context was destroyed|Cannot find context with specified id|Cannot find default execution context)\.?$/.test(
              error.message,
            )
          ) {
            return false
          }
          throw error
        }
      },
      { signal, label: 'Chromium extension popup' },
    )
    return {
      evaluate,
      evaluateCleanup,
      capture,
      // Process-group termination belongs to lifecycle.spawn's registered cleanup.
      async close() {
        browser.assertRunning()
        await cdp.close()
      },
      metadata: {
        browserVersion,
        extensionId,
        popupUrl,
        expectedVersion: manifest.version,
        expectedName: manifest.name,
        manifestVersion: manifest.version,
      },
    }
  } catch (error) {
    if (sessionId) {
      try {
        await capture('chromium-startup-failure')
      } catch (captureError) {
        error.captureError = captureError
      }
    }
    throw new Error(`Chromium startup failed: ${error.message}\n${browser.output().slice(-4000)}`, {
      cause: error,
    })
  }
}
