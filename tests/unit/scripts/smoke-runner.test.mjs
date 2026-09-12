import assert from 'node:assert/strict'
import { test } from 'node:test'
import process from 'node:process'
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { bounded, createLifecycle, waitFor } from '../../../scripts/smoke/lifecycle.mjs'
import {
  parseArgs,
  findExecutable,
  hashArtifact,
  preflight,
  ROOT,
  validateArtifactParent,
} from '../../../scripts/smoke/runner.mjs'

test('artifact parent validation resolves aliases and missing descendants without writing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'smoke-parent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const build = join(root, 'build/chromium')
  await mkdir(build, { recursive: true })
  await writeFile(join(build, 'keep'), 'unchanged')
  const before = await hashArtifact(build)
  await symlink(build, join(root, 'alias'))
  await symlink(join(root, 'build'), join(root, 'build-alias'))
  for (const parent of [
    build,
    join(build, 'new/deep'),
    join(root, 'alias'),
    join(root, 'alias/new/deep'),
    join(root, 'build-alias/chromium/new'),
  ]) {
    await assert.rejects(validateArtifactParent(parent, ['chromium'], root), /outside.*build/)
  }
  assert.equal(await hashArtifact(build), before)
  const realRoot = await fs.realpath(root)
  assert.equal(await validateArtifactParent(root, ['chromium'], root), realRoot)
  const sibling = join(root, 'build/chromium-other/new')
  assert.equal(
    await validateArtifactParent(sibling, ['chromium'], root),
    join(realRoot, 'build/chromium-other/new'),
  )
  await assert.rejects(fs.stat(sibling), { code: 'ENOENT' })
  await symlink(build, join(root, 'build/firefox'))
  await assert.rejects(
    validateArtifactParent(join(build, 'new'), ['firefox'], root),
    /outside.*build/,
  )
})

test(
  'real runner rejects unsafe artifact parents before writes and accepts build ancestors',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'smoke-parent-runner-'))
    let retainFixture = false
    t.after(async () => {
      if (retainFixture) {
        t.diagnostic(`Retaining CLI fixture after incomplete cleanup: ${root}`)
        return
      }
      await rm(root, { recursive: true, force: true })
    })
    await fs.cp(join(ROOT, 'scripts/smoke'), join(root, 'scripts/smoke'), { recursive: true })
    await fs.cp(join(ROOT, 'scripts/xvfb-smoke.mjs'), join(root, 'scripts/xvfb-smoke.mjs'))
    await writeFile(
      join(root, 'scripts/smoke/scenarios.mjs'),
      'export async function runScenarios() { return { checks: [], requests: [] } }\n',
    )
    for (const browser of ['chromium', 'firefox']) {
      const build = join(root, 'build', browser)
      await mkdir(build, { recursive: true })
      await writeFile(
        join(build, 'manifest.json'),
        JSON.stringify({ name: 'Fixture', version: '1' }),
      )
      for (const name of ['background.js', 'popup.js', 'popup.html'])
        await writeFile(join(build, name), 'fixture')
      await writeFile(
        join(root, 'scripts/smoke', `${browser}.mjs`),
        `export async function start${browser === 'chromium' ? 'Chromium' : 'Firefox'}() {
        return { metadata: {}, close: async () => {}, capture: async () => {} }
      }`,
      )
      const before = await hashArtifact(build)
      const alias = join(root, `${browser}-alias`)
      await symlink(build, alias)
      for (const parent of [build, join(build, 'new/deep'), alias, join(alias, 'new/deep'), root]) {
        const result = await invoke(
          process.execPath,
          [
            join(root, 'scripts/xvfb-smoke.mjs'),
            '--browser',
            browser,
            `--${browser}-path`,
            process.execPath,
            '--geckodriver-path',
            process.execPath,
            '--artifacts-dir',
            parent,
          ],
          root,
        ).catch((error) => {
          if (error.cleanupErrors?.length) retainFixture = true
          throw error
        })
        assert.equal(result.code, parent === root ? 0 : 2, result.output)
        if (parent !== root) {
          assert.match(result.output, /artifacts: unavailable/)
          assert.match(result.output, /Artifact parent must be outside the selected/)
        }
        assert.equal(await hashArtifact(build), before)
      }
    }
  },
)

test('smoke CLI accepts explicit selections and rejects typos, duplicates and missing values', () => {
  assert.deepEqual(parseArgs([]), { browser: 'all' })
  assert.deepEqual(parseArgs(['--browser', 'firefox', '--firefox-path', '/a path/firefox']), {
    browser: 'firefox',
    'firefox-path': '/a path/firefox',
  })
  for (const args of [
    ['--browser'],
    ['--browser', 'chrome'],
    ['--no-sandbox'],
    ['x'],
    ['--browser', 'all', '--browser', 'all'],
  ]) {
    assert.throws(() => parseArgs(args))
  }
})

test('explicit executable wins PATH; invalid explicit paths never fall back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'smoke-path-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'a browser')
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o700)
  assert.equal(await findExecutable(executable, ['node'], process.env.PATH), executable)
  assert.equal(await findExecutable(undefined, ['a browser'], directory), executable)
  await assert.rejects(
    findExecutable(join(directory, 'missing'), ['node'], process.env.PATH),
    /not found/,
  )
  await assert.rejects(findExecutable(directory, [], ''), /not found/)
})

test('build hash is stable and covers nested content and file names', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'smoke-hash-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'nested'))
  await writeFile(join(directory, 'nested/a'), 'one')
  const first = await hashArtifact(directory)
  assert.equal(await hashArtifact(directory), first)
  await writeFile(join(directory, 'nested/a'), 'two')
  const changedContent = await hashArtifact(directory)
  assert.notEqual(changedContent, first)
  await rename(join(directory, 'nested/a'), join(directory, 'nested/renamed'))
  const changedName = await hashArtifact(directory)
  assert.notEqual(changedName, changedContent)
  await writeFile(join(directory, 'nested/b'), 'two')
  assert.notEqual(await hashArtifact(directory), changedName)
})

test('preflight rejects missing artifacts', { skip: process.platform !== 'linux' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'smoke-preflight-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await assert.rejects(
    preflight({ browser: 'chromium', 'chromium-path': process.execPath }, directory),
    /ENOENT/,
  )
})

test('preflight preserves cancellation before checking executables or artifacts', async () => {
  const controller = new AbortController()
  const reason = new Error('Cancelled before preflight')
  controller.abort(reason)
  await assert.rejects(
    preflight({ browser: 'chromium', 'chromium-path': '/missing' }, '/missing', controller.signal),
    (error) => error === reason,
  )
})

test(
  'preflight passes cancellation into artifact reads and stops the walk',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'smoke-preflight-abort-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const build = join(directory, 'build/chromium')
    await mkdir(build, { recursive: true })
    await writeFile(join(build, 'manifest.json'), JSON.stringify({ name: 'Fixture', version: '1' }))
    for (const name of ['background.js', 'popup.js', 'popup.html'])
      await writeFile(join(build, name), 'current build')
    const controller = new AbortController()
    const reason = new Error('Cancelled during artifact read')
    const originalReadFile = fs.readFile
    let cancelledRead = false
    let readsAfterAbort = 0
    t.mock.method(fs, 'readFile', async (path, options) => {
      if (controller.signal.aborted) readsAfterAbort++
      if (path === join(build, 'background.js')) {
        cancelledRead = true
        assert.equal(options?.signal, controller.signal)
        controller.abort(reason)
      }
      return originalReadFile(path, options)
    })
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    await assert.rejects(
      preflight(
        { browser: 'chromium', 'chromium-path': process.execPath },
        directory,
        controller.signal,
      ),
      (error) => error.name === 'AbortError' && error.cause === reason,
    )
    assert.equal(cancelledRead, true)
    assert.equal(readsAfterAbort, 0)
  },
)

test(
  'Firefox preflight selects the directory independently of distribution ZIPs',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'smoke-firefox-preflight-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const build = join(directory, 'build/firefox')
    await mkdir(build, { recursive: true })
    await writeFile(join(build, 'manifest.json'), JSON.stringify({ name: 'Fixture', version: '1' }))
    for (const name of ['background.js', 'popup.js', 'popup.html'])
      await writeFile(join(build, name), 'current build')
    const options = {
      browser: 'firefox',
      'firefox-path': process.execPath,
      'geckodriver-path': process.execPath,
    }
    const [withoutZip] = await preflight(options, directory)
    await writeFile(join(directory, 'build/firefox.zip'), 'stale archive')
    const [withStaleZip] = await preflight(options, directory)
    assert.equal(withoutZip.artifactSha256, await hashArtifact(build))
    assert.deepEqual(withStaleZip, withoutZip)
    assert.equal(Object.hasOwn(withStaleZip, 'archive'), false)
    assert.equal(Object.hasOwn(withStaleZip, 'archiveSha256'), false)
  },
)

test(
  'Firefox preflight rejects a symlink build root before snapshot startup',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'smoke-firefox-symlink-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const build = join(directory, 'actual-build')
    await mkdir(build)
    await mkdir(join(directory, 'build'))
    await writeFile(join(build, 'manifest.json'), JSON.stringify({ name: 'Fixture', version: '1' }))
    for (const name of ['background.js', 'popup.js', 'popup.html'])
      await writeFile(join(build, name), 'current build')
    await symlink(build, join(directory, 'build/firefox'))
    await assert.rejects(
      preflight(
        {
          browser: 'firefox',
          'firefox-path': process.execPath,
          'geckodriver-path': process.execPath,
        },
        directory,
      ),
      /Firefox build source must be a directory/,
    )
  },
)

async function invoke(command, args, cwd) {
  const lifecycle = createLifecycle()
  let managed
  let result
  let failure
  try {
    managed = lifecycle.spawn(command, args, { cwd })
    result = await bounded(managed.exited, 10000, 'CLI timeout')
  } catch (error) {
    failure = error
  }
  // Reuse owned-group termination, child reaping and pipe draining before settling.
  const cleanupErrors = await lifecycle.cleanup()
  if (cleanupErrors.length)
    throw Object.assign(
      new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        failure?.message || 'CLI cleanup failed',
        failure ? { cause: failure } : undefined,
      ),
      { cleanupErrors },
    )
  if (failure) throw failure
  return { code: result.code, output: managed.output() }
}

test(
  'CLI invocation preserves exit status and output and reports spawn failure',
  { skip: process.platform !== 'linux' },
  async () => {
    const result = await invoke(
      process.execPath,
      [
        '-e',
        'process.stdout.write("stdout"); process.stderr.write("stderr"); process.exitCode = 7',
      ],
      tmpdir(),
    )
    assert.equal(result.code, 7)
    assert.match(result.output, /stdout/)
    assert.match(result.output, /stderr/)
    await assert.rejects(
      invoke(join(import.meta.dirname, 'missing-cli-executable'), [], tmpdir()),
      /ENOENT/,
    )
  },
)

test(
  'CLI timeouts stop owned descendants before rejecting',
  { timeout: 30000, skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'smoke-cli-timeout-'))
    const marker = join(directory, 'pids.json')
    async function running(pid) {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
        return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return false
        throw error
      }
    }
    t.after(async () => {
      let pids = []
      try {
        pids = JSON.parse(await fs.readFile(marker, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      for (const pid of pids) {
        assert.ok(Number.isInteger(pid) && pid > 0)
        if (await running(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
      }
      await waitFor(async () => (await Promise.all(pids.map(running))).every((value) => !value), {
        timeoutMs: 5000,
        label: 'owned CLI fixture processes stopped',
      })
      await rm(directory, { recursive: true, force: true })
    })
    const source = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const child = spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]))
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `
    await assert.rejects(invoke(process.execPath, ['-e', source, marker], directory), /CLI timeout/)
    const pids = JSON.parse(await fs.readFile(marker, 'utf8'))
    assert.equal(pids.length, 2)
    for (const pid of pids) assert.equal(await running(pid), false, `Owned process ${pid} survived`)
  },
)

test(
  'Node, shell and npm entries work outside the repository and propagate argument failures',
  { skip: process.platform !== 'linux' },
  async () => {
    const entries = [
      [process.execPath, [join(ROOT, 'scripts/xvfb-smoke.mjs')]],
      ['sh', [join(ROOT, 'scripts/run-smoke.sh')]],
      ['npm', ['--prefix', ROOT, 'run', 'smoke', '--']],
    ]
    for (const [command, args] of entries) {
      const help = await invoke(command, [...args, '--help'], tmpdir())
      assert.equal(help.code, 0, help.output)
      assert.match(help.output, /Usage: npm run smoke/)
      const invalid = await invoke(command, [...args, '--invalid'], tmpdir())
      assert.equal(invalid.code, 2, invalid.output)
    }
  },
)
