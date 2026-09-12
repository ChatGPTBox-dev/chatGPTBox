import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function hashArtifact(directory, signal) {
  const hash = createHash('sha256').update('chatgptbox-smoke-artifact-v2\0')
  function frame(bytes) {
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.length))
    hash.update(length).update(bytes)
  }
  async function visit(relative = '') {
    signal?.throwIfAborted()
    const entries = await readdir(join(directory, relative), { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      signal?.throwIfAborted()
      const path = join(relative, entry.name)
      if (entry.isDirectory()) {
        hash.update('d')
        frame(Buffer.from(path))
        await visit(path)
      } else if (entry.isFile()) {
        hash.update('f')
        frame(Buffer.from(path))
        frame(await readFile(join(directory, path), { signal }))
      } else throw new Error(`Unexpected non-regular build artifact: ${path}`)
    }
  }
  await visit()
  signal?.throwIfAborted()
  return hash.digest('hex')
}

export async function snapshotArtifact(source, destination, expectedHash, signal) {
  signal?.throwIfAborted()
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error('Missing preflight build hash')
  if (!(await lstat(source)).isDirectory()) throw new Error('Build source must be a directory')
  // The destination belongs to this run's retained artifacts, never a browser profile.
  await mkdir(destination)
  async function copyDirectory(from, to) {
    signal?.throwIfAborted()
    for (const entry of await readdir(from, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const input = join(from, entry.name)
      const output = join(to, entry.name)
      if (entry.isDirectory()) {
        await mkdir(output)
        await copyDirectory(input, output)
      } else if (entry.isFile()) {
        try {
          // pipeline destroys both streams on abort and waits for their closure.
          await pipeline(createReadStream(input), createWriteStream(output, { flags: 'wx' }), {
            signal,
          })
        } catch (error) {
          signal?.throwIfAborted()
          throw error
        }
      } else throw new Error(`Unexpected non-regular build artifact: ${input}`)
    }
  }
  await copyDirectory(source, destination)
  signal?.throwIfAborted()
  const actualHash = await hashArtifact(destination, signal)
  if (actualHash !== expectedHash) throw new Error('Build changed since preflight')
  return actualHash
}
