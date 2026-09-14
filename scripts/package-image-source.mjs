import archiver from 'archiver'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { mkdir, lstat } from 'node:fs/promises'
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
  /^(?:token|api[-_]?key|config)(?:\..*)?$/i,
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

const execFileAsync = promisify(execFile)

export async function collectSourceFiles(root = defaultRoot) {
  // Require Git rather than falling back to a recursive walk in extracted ZIPs.
  const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '-z'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  })
  const files = []
  for (const relativePath of new Set(stdout.split('\0').filter(Boolean))) {
    if (
      !SOURCE_ARCHIVE_ROOTS.some(
        (allowed) => relativePath === allowed || relativePath.startsWith(`${allowed}/`),
      )
    )
      continue
    if (isSensitiveSourcePath(relativePath)) continue
    const segments = relativePath.split('/')
    if (segments.some((part) => part === '..') || path.isAbsolute(relativePath)) continue
    let regular = true
    for (let i = 1; i <= segments.length; i++) {
      const stat = await lstat(path.join(root, ...segments.slice(0, i)))
      if (stat.isSymbolicLink() || (i === segments.length && !stat.isFile())) {
        regular = false
        break
      }
    }
    if (regular) files.push(relativePath)
  }
  return files.sort()
}

export async function createImageSourceArchive(root = defaultRoot) {
  const files = await collectSourceFiles(root)
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

  for (const relativePath of files) {
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
