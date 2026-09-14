import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import streams from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { hashArtifact, snapshotArtifact } from '../../../scripts/smoke/artifacts.mjs'
import { bounded } from '../../../scripts/smoke/lifecycle.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'smoke-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'snapshot')
  await mkdir(source)
  await mkdir(join(source, 'nested'))
  await writeFile(join(source, 'nested/file'), 'original')
  const hash = await hashArtifact(source)
  return { root, source, destination, hash }
}

test('snapshot includes nested files and is independent from later build writes', async (t) => {
  const { source, destination, hash } = await fixture(t)
  assert.equal(await snapshotArtifact(source, destination, hash), hash)
  await writeFile(join(source, 'nested/file'), 'new build')
  assert.equal(await readFile(join(destination, 'nested/file'), 'utf8'), 'original')
  assert.equal(await hashArtifact(destination), hash)
})

for (const operation of ['add', 'remove']) {
  test(`snapshot rejects an empty directory ${operation} after preflight`, async (t) => {
    const { source, destination } = await fixture(t)
    const empty = join(source, 'empty')
    if (operation === 'remove') await mkdir(empty)
    const hash = await hashArtifact(source)
    if (operation === 'add') await mkdir(empty)
    else await rm(empty, { recursive: true })
    assert.notEqual(await hashArtifact(source), hash)
    await assert.rejects(
      snapshotArtifact(source, destination, hash),
      /Build changed since preflight/,
    )
  })
}

test('binary contents cannot impersonate a second artifact entry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'smoke-hash-framing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  await writeFile(join(first, 'a'), Buffer.from('first\0b\0second'))
  await writeFile(join(second, 'a'), 'first')
  await writeFile(join(second, 'b'), 'second')
  const hash = await hashArtifact(first)
  assert.notEqual(await hashArtifact(second), hash)
  await assert.rejects(
    snapshotArtifact(second, join(root, 'snapshot'), hash),
    /Build changed since preflight/,
  )
})

test(
  'snapshot rejects symlinks instead of reading outside the build',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { root, source, destination, hash } = await fixture(t)
    await writeFile(join(root, 'outside'), 'not a build artifact')
    await symlink(join(root, 'outside'), join(source, 'link'))
    await assert.rejects(snapshotArtifact(source, destination, hash), /non-regular build artifact/)
  },
)

test('snapshot never overwrites an existing destination', async (t) => {
  const { source, destination, hash } = await fixture(t)
  await mkdir(destination)
  await writeFile(join(destination, 'existing'), 'retain')
  await assert.rejects(snapshotArtifact(source, destination, hash), { code: 'EEXIST' })
  assert.equal(await readFile(join(destination, 'existing'), 'utf8'), 'retain')
})

test('snapshot checks preflight hash and cancellation before acquiring a destination', async (t) => {
  const { source, destination, hash } = await fixture(t)
  await assert.rejects(snapshotArtifact(source, destination), /Missing preflight build hash/)
  const controller = new AbortController()
  const reason = new Error('Cancelled before snapshot')
  controller.abort(reason)
  await assert.rejects(
    snapshotArtifact(source, destination, hash, controller.signal),
    (error) => error === reason,
  )
  await assert.rejects(stat(destination), { code: 'ENOENT' })
})

test('snapshot cancellation waits for the transfer to close', { timeout: 5000 }, async (t) => {
  const { source, destination, hash } = await fixture(t)
  const started = Promise.withResolvers()
  const destroying = Promise.withResolvers()
  const release = Promise.withResolvers()
  const input = new PassThrough({
    destroy(error, callback) {
      destroying.resolve()
      release.promise.then(() => callback(error))
    },
  })
  const mockRead = t.mock.method(streams, 'createReadStream', () => {
    input.write('partial')
    started.resolve()
    return input
  })
  syncBuiltinESMExports()
  t.after(() => {
    release.resolve()
    input.destroy()
    mockRead.mock.restore()
    syncBuiltinESMExports()
  })
  const controller = new AbortController()
  const reason = new Error('Cancel the active transfer')
  let settled = false
  const rejected = assert.rejects(
    snapshotArtifact(source, destination, hash, controller.signal).finally(() => {
      settled = true
    }),
    (error) => error === reason,
  )
  await bounded(started.promise, 1000, 'Snapshot transfer')
  controller.abort(reason)
  await bounded(destroying.promise, 1000, 'Transfer destruction')
  await setImmediate()
  assert.equal(settled, false, 'A pending close must not be abandoned')
  release.resolve()
  await bounded(rejected, 1000, 'Snapshot cancellation')
  assert.equal(input.closed, true)
})
