import process from 'node:process'
import { constants, mkdtempSync, writeFileSync } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bounded, createLifecycle } from './lifecycle.mjs'
import { startChromium } from './chromium.mjs'
import { startFirefox } from './firefox.mjs'
import { runScenarios } from './scenarios.mjs'
import { hashArtifact } from './artifacts.mjs'

export { hashArtifact }

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const HELP = `Usage: npm run smoke -- [options]
  --browser all|chromium|firefox  Selected browsers (default: all, run serially)
  --chromium-path PATH           Full Chromium or Chrome for Testing executable
  --firefox-path PATH            Firefox executable
  --geckodriver-path PATH        Native geckodriver executable (not an npm wrapper)
  --artifacts-dir PATH           Parent directory for a unique retained run directory
  --help                        Show this help

Requires Linux, Node 22+, and production builds in this worktree.
No downloads, dependency installation, or builds are performed automatically.
Exit: 0 pass; 1 test/runtime/cleanup failure; 2 preflight; 130 SIGINT; 143 SIGTERM.
`

export function parseArgs(args) {
  const options = { browser: 'all' }
  const allowed = new Set([
    'browser',
    'chromium-path',
    'firefox-path',
    'geckodriver-path',
    'artifacts-dir',
  ])
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const key = args[index].slice(2)
    if (args[index] === '--help') {
      options.help = true
      continue
    }
    if (!args[index].startsWith('--') || !allowed.has(key) || seen.has(key)) {
      throw new Error(`Unknown or repeated option: ${args[index]}`)
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    seen.add(key)
    options[key] = value
  }
  if (!['all', 'chromium', 'firefox'].includes(options.browser))
    throw new Error(`Invalid browser: ${options.browser}`)
  return options
}

export async function findExecutable(explicit, candidates, pathValue = process.env.PATH || '') {
  const paths = explicit
    ? [resolve(explicit)]
    : pathValue
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => candidates.map((name) => join(dir, name)))
  for (const path of paths) {
    try {
      await access(path, constants.X_OK)
      if ((await stat(path)).isFile()) return resolve(path)
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error
    }
  }
  throw new Error(
    `Executable not found: ${explicit || candidates.join(' / ')}; specify its --*-path`,
  )
}

export async function preflight(options, root = ROOT, signal) {
  signal?.throwIfAborted()
  if (process.platform !== 'linux') throw new Error('Smoke currently supports Linux only')
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ is required')
  const browsers = options.browser === 'all' ? ['chromium', 'firefox'] : [options.browser]
  const jobs = []
  for (const browser of browsers) {
    signal?.throwIfAborted()
    const executable = await findExecutable(
      options[`${browser}-path`],
      browser === 'chromium' ? ['chromium', 'chromium-browser', 'chrome-for-testing'] : ['firefox'],
    )
    const extensionDir = join(root, 'build', browser)
    if (browser === 'firefox' && !(await lstat(extensionDir)).isDirectory())
      throw new Error('Firefox build source must be a directory')
    for (const name of ['manifest.json', 'background.js', 'popup.html', 'popup.js']) {
      if (!(await stat(join(extensionDir, name))).isFile())
        throw new Error(`Missing build file: ${name}`)
    }
    const manifest = JSON.parse(
      await readFile(join(extensionDir, 'manifest.json'), { encoding: 'utf8', signal }),
    )
    if (!manifest.version || !manifest.name) throw new Error(`Invalid ${browser} manifest`)
    const job = {
      browser,
      executable,
      extensionDir,
      manifest,
      artifactSha256: await hashArtifact(extensionDir, signal),
    }
    if (browser === 'firefox') {
      job.geckodriver = await findExecutable(options['geckodriver-path'], ['geckodriver'])
      // npm launchers may download binaries; require an already installed native driver.
      const header = (await readFile(job.geckodriver, { signal })).subarray(0, 4)
      if (header.toString('hex') !== '7f454c46')
        throw new Error('Specify a native Linux geckodriver binary, not a downloading wrapper')
    }
    signal?.throwIfAborted()
    jobs.push(job)
  }
  return jobs
}

// Resolve existing symlinks even when the requested directory has not been created yet.
async function resolveFuturePath(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A dangling symlink is not a missing directory that mkdir can safely create.
    const entry = await lstat(path).catch((failure) => {
      if (failure.code !== 'ENOENT') throw failure
    })
    if (entry || dirname(path) === path) throw error
    return join(await resolveFuturePath(dirname(path)), basename(path))
  }
}

export async function validateArtifactParent(parent, browsers, root = ROOT) {
  const resolvedParent = await resolveFuturePath(resolve(parent))
  for (const browser of browsers) {
    const build = await resolveFuturePath(join(root, 'build', browser))
    const nesting = relative(build, resolvedParent)
    if (!nesting || (!isAbsolute(nesting) && nesting !== '..' && !nesting.startsWith(`..${sep}`)))
      throw new Error(`Artifact parent must be outside the selected ${browser} build`)
  }
  // Ancestors are safe: mkdtemp creates a new, exclusive sibling of any existing build.
  return resolvedParent
}

export async function run(args) {
  let options
  try {
    options = parseArgs(args)
  } catch (error) {
    console.error(error.message)
    return 2
  }
  if (options.help) {
    console.log(HELP)
    return 0
  }
  const controller = new AbortController()
  let lifecycle = createLifecycle({ signal: controller.signal })
  let signalCode
  let activeAdapter
  let artifactsDir
  const report = {
    result: 'FAIL',
    selectedBrowsers: options.browser === 'all' ? ['chromium', 'firefox'] : [options.browser],
    nodeVersion: process.version,
    root: ROOT,
    browsers: [],
    failedStage: 'preflight',
    cleanup: [],
  }
  function abort(error, code) {
    signalCode ||= code
    if (controller.signal.aborted) {
      lifecycle.force()
      return
    }
    controller.abort(error)
  }
  const onInterrupt = () => abort(new Error('Interrupted by SIGINT'), 130)
  const onTerminate = () => abort(new Error('Interrupted by SIGTERM'), 143)
  const onFatal = (error) => abort(error instanceof Error ? error : new Error(String(error)), 1)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  process.on('uncaughtException', onFatal)
  process.on('unhandledRejection', onFatal)
  process.stdout.on('error', onFatal)
  process.stderr.on('error', onFatal)
  let exitCode = 1
  async function cleanupBrowser() {
    const errors = await lifecycle.cleanup()
    report.cleanup = [
      ...new Set([...report.cleanup, ...errors.map((error) => String(error.stack || error))]),
    ]
    return errors
  }
  function applyLateSignal() {
    if (!signalCode || exitCode === signalCode) return
    exitCode = signalCode
    report.exitCode = exitCode
    report.result = 'FAIL'
    report.failedStage ||= 'reporting'
    // No await between this final signal snapshot, report update, and returning the status.
    if (artifactsDir)
      writeFileSync(join(artifactsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  try {
    const parent = await validateArtifactParent(
      options['artifacts-dir'] || tmpdir(),
      report.selectedBrowsers,
    )
    controller.signal.throwIfAborted()
    await mkdir(parent, { recursive: true })
    controller.signal.throwIfAborted()
    artifactsDir = mkdtempSync(join(parent, 'chatgptbox-smoke-'))
    report.artifactsDir = artifactsDir
    const jobs = await bounded(
      preflight(options, ROOT, controller.signal),
      60000,
      'Preflight',
      controller.signal,
    )
    report.failedStage = 'startup'
    await bounded(
      (async () => {
        for (const job of jobs) {
          controller.signal.throwIfAborted()
          if (report.browsers.length) lifecycle = createLifecycle({ signal: controller.signal })
          const browserDir = join(artifactsDir, job.browser)
          await mkdir(browserDir)
          controller.signal.throwIfAborted()
          // Keep acquisition and registration synchronous so cancellation cannot leak a profile.
          const profileDir = mkdtempSync(join(tmpdir(), `chatgptbox-${job.browser}-`))
          const profileLifecycle = lifecycle
          lifecycle.defer(`${job.browser} profile`, async () => {
            await profileLifecycle.assertProcessesStopped()
            await rm(profileDir, { recursive: true, force: true })
          })
          const browserReport = {
            browser: job.browser,
            executable: job.executable,
            artifactSha256: job.artifactSha256,
            ...(job.browser === 'firefox'
              ? {
                  preflightManifestVersion: job.manifest.version,
                  snapshotDir: join(browserDir, 'extension'),
                }
              : { manifestVersion: job.manifest.version }),
            profileDir,
            checks: [],
          }
          report.browsers.push(browserReport)
          report.failedStage = `${job.browser}:startup`
          activeAdapter = await bounded(
            (job.browser === 'chromium' ? startChromium : startFirefox)({
              ...job,
              profileDir,
              artifactsDir: browserDir,
              lifecycle,
              signal: controller.signal,
            }),
            60000,
            `${job.browser} startup`,
            controller.signal,
          )
          Object.assign(browserReport, activeAdapter.metadata)
          report.failedStage = `${job.browser}:scenarios`
          Object.assign(
            browserReport,
            await runScenarios(activeAdapter, {
              lifecycle,
              signal: controller.signal,
              checks: browserReport.checks,
            }),
          )
          report.failedStage = `${job.browser}:shutdown`
          await activeAdapter.close()
          activeAdapter = undefined
          report.failedStage = `${job.browser}:cleanup`
          const cleanupErrors = await cleanupBrowser()
          if (cleanupErrors.length)
            throw new AggregateError(cleanupErrors, `${job.browser} cleanup failed`)
        }
      })(),
      300000,
      'Smoke run',
      controller.signal,
    )
    exitCode = 0
    report.failedStage = null
  } catch (error) {
    exitCode = signalCode || (report.failedStage === 'preflight' ? 2 : 1)
    report.error = String(error.stack || error)
    if (!artifactsDir && !process.stderr.destroyed) console.error(String(error.message || error))
    report.cleanup.push(
      ...(error.cleanupErrors || []).map((failure) => String(failure.stack || failure)),
    )
    if (activeAdapter && !controller.signal.aborted) {
      try {
        await bounded(activeAdapter.capture('failure'), 3000, 'Failure capture')
      } catch (captureError) {
        report.captureError = String(captureError)
      }
    }
  } finally {
    controller.abort(new Error('Smoke run finished'))
    await cleanupBrowser()
    if (report.cleanup.length && exitCode === 0) {
      exitCode = 1
      report.failedStage = 'cleanup'
    }
    exitCode = signalCode || exitCode
    report.exitCode = exitCode
    report.result = exitCode === 0 ? 'PASS' : 'FAIL'
    try {
      if (artifactsDir)
        await writeFile(join(artifactsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
      applyLateSignal()
      await new Promise((resolve, reject) => {
        process.stdout.write(
          `Smoke report; artifacts: ${artifactsDir || 'unavailable'}\n`,
          (error) => (error ? reject(error) : resolve()),
        )
      })
    } catch (error) {
      exitCode = signalCode || 1
      report.exitCode = exitCode
      report.result = 'FAIL'
      report.failedStage ||= 'reporting'
      report.reportingError = String(error.stack || error)
      if (artifactsDir) {
        try {
          await writeFile(join(artifactsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
        } catch (writeError) {
          if (!process.stderr.destroyed)
            console.error(`Cannot write smoke report: ${writeError.message}`)
        }
      }
      if (!process.stderr.destroyed) console.error(`Smoke reporting failed: ${error.message}`)
    }
    try {
      applyLateSignal()
    } catch (error) {
      exitCode = signalCode || 1
      if (!process.stderr.destroyed) console.error(`Cannot finalize smoke report: ${error.message}`)
    }
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    process.removeListener('uncaughtException', onFatal)
    process.removeListener('unhandledRejection', onFatal)
    process.stdout.removeListener('error', onFatal)
    process.stderr.removeListener('error', onFatal)
  }
  return exitCode
}
