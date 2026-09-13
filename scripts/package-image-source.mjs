import archiver from 'archiver'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultRoot = fileURLToPath(new URL('../', import.meta.url))

// Source archives are distributable artifacts. Keep their roots explicit so an
// unrelated local file at the repository root can never be packaged by accident.
export const SOURCE_ARCHIVE_ROOTS = Object.freeze([
  '.github',
  'badges',
  'safari',
  'screenshots',
  'scripts',
  'src',
  'tests',
  '.eslintrc.json',
  '.gitattributes',
  '.gitignore',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  'AGENTS.md',
  'build.mjs',
  'CURRENT_CHANGE.md',
  'IMAGE-SUPPORT.zh-CN.md',
  'LICENSE',
  'package-lock.json',
  'package.json',
  'README.md',
  'README_IN.md',
  'README_JA.md',
  'README_TR.md',
  'README_ZH.md',
  'SOURCE_CODE_REVIEW.md',
])

const excludedDirectoryNames = new Set([
  '.git',
  '.cache',
  '.coverage',
  'build',
  'coverage',
  'node_modules',
  'test-results',
])

const sensitiveFilePatterns = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^auth(?:\..*)?$/i,
  /^credentials?(?:\..*)?$/i,
  /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\..*)?$/i,
  /^secrets?(?:\..*)?$/i,
  /\.(?:cer|crt|der|jks|key|keystore|p12|pem|pfx)$/i,
]

export function isSensitiveSourcePath(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean)
  if (segments.some((segment) => excludedDirectoryNames.has(segment))) return true
  const basename = segments.at(-1) ?? ''
  return sensitiveFilePatterns.some((pattern) => pattern.test(basename))
}

async function collectDirectoryFiles(root, relativeDirectory, files) {
  const absoluteDirectory = path.join(root, relativeDirectory)
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name)
    if (isSensitiveSourcePath(relativePath)) continue
    if (entry.isDirectory()) await collectDirectoryFiles(root, relativePath, files)
    else if (entry.isFile()) files.push(relativePath)
  }
}

export async function collectSourceFiles(root = defaultRoot) {
  const files = []
  for (const archiveRoot of SOURCE_ARCHIVE_ROOTS) {
    if (isSensitiveSourcePath(archiveRoot)) continue
    try {
      await collectDirectoryFiles(root, archiveRoot, files)
    } catch (error) {
      if (error?.code === 'ENOTDIR') {
        files.push(archiveRoot)
        continue
      }
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
  return files.sort()
}

export async function createImageSourceArchive(root = defaultRoot) {
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

  for (const relativePath of await collectSourceFiles(root)) {
    archive.file(path.join(root, relativePath), {
      name: `chatgptbox-image-support/${relativePath.replaceAll('\\', '/')}`,
    })
  }
  await archive.finalize()
  await completed
  console.log(`Created ${outputPath} (${archive.pointer()} bytes)`)
  return outputPath
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createImageSourceArchive()
}
