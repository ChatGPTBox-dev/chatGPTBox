import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { bounded, waitFor } from './lifecycle.mjs'
import { snapshotArtifact } from './artifacts.mjs'

export async function startFirefox({
  executable,
  geckodriver,
  extensionDir,
  artifactSha256,
  profileDir,
  artifactsDir,
  lifecycle,
  signal,
}) {
  signal?.throwIfAborted()
  const snapshotDir = resolve(artifactsDir, 'extension')
  await snapshotArtifact(extensionDir, snapshotDir, artifactSha256, signal)
  const manifest = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), { signal }))
  if (!manifest.name || !manifest.version) throw new Error('Invalid Firefox snapshot manifest')
  const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup
  if (
    typeof popup !== 'string' ||
    !popup.trim() ||
    popup !== popup.trim() ||
    /^[a-z][a-z\d+.-]*:|^\/\//i.test(popup)
  )
    throw new Error('Invalid Firefox manifest popup path')
  signal?.throwIfAborted()
  const managed = lifecycle.spawn(
    geckodriver,
    [
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--websocket-port',
      '0',
      '--profile-root',
      resolve(profileDir),
      '--allow-system-access',
    ],
    { logPath: join(artifactsDir, 'geckodriver.log'), env: { ...process.env } },
  )
  let origin
  let sessionId
  let closing

  async function request(method, path, body, { cleanup = false, timeoutMs = 30000 } = {}) {
    if (!cleanup) {
      signal?.throwIfAborted()
      managed.assertRunning()
    }
    const controller = new AbortController()
    const requestSignal =
      signal && !cleanup ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const label = `Firefox WebDriver ${method} ${path}`
    try {
      return await bounded(
        (async () => {
          const response = await fetch(`${origin}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: requestSignal,
            redirect: 'error',
          })
          const text = await response.text()
          let payload
          try {
            payload = JSON.parse(text)
          } catch {
            throw new Error(`${label}: HTTP ${response.status}, invalid JSON response`)
          }
          if (!response.ok || payload?.value?.error) {
            throw new Error(
              `${label}: HTTP ${response.status}: ${payload?.value?.error || 'request failed'}: ${
                payload?.value?.message || ''
              }`,
            )
          }
          if (!payload || !Object.hasOwn(payload, 'value')) {
            throw new Error(`${label}: missing WebDriver value`)
          }
          return payload.value
        })(),
        timeoutMs,
        label,
        requestSignal,
      )
    } finally {
      controller.abort()
    }
  }

  function command(method, path, body, options) {
    return request(method, `/session/${encodeURIComponent(sessionId)}${path}`, body, options)
  }

  function close() {
    if (!closing) {
      closing = sessionId
        ? command('DELETE', '', undefined, { cleanup: true, timeoutMs: 5000 })
        : Promise.resolve()
    }
    return closing
  }
  lifecycle.defer('Firefox WebDriver session', close)

  origin = await waitFor(
    async () => {
      managed.assertRunning()
      const match = managed.output().match(/Listening on 127\.0\.0\.1:(\d+)(?=\r?\n)/)
      if (!match) return false
      const port = Number(match[1])
      if (port < 1 || port > 65535) throw new Error('Invalid geckodriver listening port')
      return `http://127.0.0.1:${port}`
    },
    { timeoutMs: 15000, signal, label: 'geckodriver listening port' },
  )
  await waitFor(
    async () => {
      const status = await request('GET', '/status')
      if (typeof status?.ready !== 'boolean')
        throw new Error('Invalid geckodriver readiness status')
      return status.ready
    },
    { timeoutMs: 15000, signal, label: 'geckodriver ready' },
  )

  const session = await request(
    'POST',
    '/session',
    {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            binary: executable,
            args: ['-headless'],
            prefs: {
              'intl.accept_languages': 'en-US,en',
              'browser.shell.checkDefaultBrowser': false,
            },
          },
        },
      },
    },
    { timeoutMs: 60000 },
  )
  sessionId = session?.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    sessionId = undefined
    throw new Error('Firefox WebDriver returned an empty session ID')
  }
  await command('POST', '/timeouts', { script: 30000, pageLoad: 30000, implicit: 0 })
  const extensionId = await command('POST', '/moz/addon/install', {
    path: snapshotDir,
    temporary: true,
  })
  if (typeof extensionId !== 'string' || !extensionId.trim()) {
    throw new Error('Firefox returned an empty addon ID')
  }
  const previousHandles = await command('GET', '/window/handles')
  await command('POST', '/moz/context', { context: 'chrome' })
  const extensionBase = await command('POST', '/execute/sync', {
    script: `const policy = WebExtensionPolicy.getByID(arguments[0]);
      if (!policy) throw new Error('Installed extension policy not found');
      return policy.getURL('');`,
    args: [extensionId],
  })
  if (typeof extensionBase !== 'string' || !extensionBase.startsWith('moz-extension://')) {
    throw new Error('Firefox returned an invalid extension URL')
  }
  const base = new URL(extensionBase)
  const target = new URL(popup, base)
  if (
    target.protocol !== 'moz-extension:' ||
    target.host !== base.host ||
    target.username ||
    target.password
  )
    throw new Error('Firefox popup must belong to the installed extension')
  const popupUrl = target.href
  await command('POST', '/execute/sync', {
    script: `const tab = gBrowser.addTab(arguments[0], {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
    });
    gBrowser.selectedTab = tab;`,
    args: [popupUrl],
  })
  await command('POST', '/moz/context', { context: 'content' })
  const handle = await waitFor(
    async () => {
      const handles = await command('GET', '/window/handles')
      return handles.find((candidate) => !previousHandles.includes(candidate))
    },
    { timeoutMs: 10000, signal, label: 'Firefox popup window' },
  )
  await command('POST', '/window', { handle })

  async function evaluateWithOptions(options, fn, ...args) {
    if (typeof fn !== 'function') throw new TypeError('evaluate requires a function')
    const result = await command(
      'POST',
      '/execute/async',
      {
        script: `const done = arguments[arguments.length - 1];
        const args = Array.prototype.slice.call(arguments, 0, -1);
        Promise.resolve().then(() => (${fn.toString()})(...args)).then(
          value => done({ ok: true, value: value === undefined ? null : value }),
          error => done({ ok: false, smokeError: {
            message: String(error), stack: String(error && error.stack || '')
          } })
        );`,
        args,
      },
      options,
    )
    if (result?.ok !== true) {
      const detail = result?.smokeError
      throw new Error(
        `Firefox evaluation failed: ${detail?.message || 'invalid script result'}${
          detail?.stack ? `\n${detail.stack}` : ''
        }`,
      )
    }
    return result.value
  }
  const evaluate = (fn, ...args) => evaluateWithOptions(undefined, fn, ...args)
  const evaluateCleanup = (fn, ...args) =>
    evaluateWithOptions({ cleanup: true, timeoutMs: 5000 }, fn, ...args)

  await waitFor(
    () => evaluate((url) => location.href === url && document.readyState === 'complete', popupUrl),
    { timeoutMs: 15000, signal, label: 'Firefox popup document' },
  )

  async function capture(prefix) {
    const destination = resolve(artifactsDir, prefix)
    if (dirname(destination) !== resolve(artifactsDir)) {
      throw new Error('Capture prefix must name a file inside artifactsDir')
    }
    const screenshot = await command('GET', '/screenshot')
    await writeFile(`${destination}.png`, Buffer.from(screenshot, 'base64'))
    const source = await command('GET', '/source')
    await writeFile(`${destination}.html`, source)
  }

  return {
    evaluate,
    evaluateCleanup,
    capture,
    close,
    metadata: {
      browserVersion: session.capabilities?.browserVersion,
      extensionId,
      popupUrl,
      expectedVersion: manifest.version,
      expectedName: manifest.name,
      artifactSha256,
      snapshotDir,
      manifestVersion: manifest.version,
    },
  }
}
