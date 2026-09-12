import archiver from 'archiver'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const outputDirectory = path.join(root, 'build')
await mkdir(outputDirectory, { recursive: true })
const outputPath = path.join(outputDirectory, 'chatgptbox-image-support-source.zip')
const output = createWriteStream(outputPath)
const archive = archiver('zip', { zlib: { level: 9 } })
const completed = new Promise((resolve, reject) => {
  output.on('close', resolve)
  output.on('error', reject)
  archive.on('error', reject)
  archive.on('warning', reject)
})
archive.pipe(output)

// Include hidden build/configuration files, but never local dependencies,
// browser test profiles, Git metadata, or generated artifacts.
const excluded = new Set([
  '.git',
  'node_modules',
  'build',
  'test-results',
  '.cache',
  'coverage',
  '.coverage',
])
async function addDirectory(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue
    const relativePath = path.posix.join(relative, entry.name)
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) await addDirectory(absolutePath, relativePath)
    else if (entry.isFile()) {
      archive.file(absolutePath, { name: `chatgptbox-image-support/${relativePath}` })
    }
  }
}
await addDirectory(root)
await archive.finalize()
await completed
console.log(`Created ${outputPath} (${archive.pointer()} bytes)`)
