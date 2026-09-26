import archiver from 'archiver'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
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
  /^(?:token|api[-_]?key)(?:\..*)?$/i,
  /^config\.json$/i,
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
    files.push(relativePath)
  }
  return files.sort()
}

function isSameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

export async function readVerifiedSourceFile(root, relativePath) {
  const segments = relativePath.split('/')
  if (
    segments.length === 0 ||
    segments.some((part) => !part || part === '..') ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Unsafe source path: ${relativePath}`)
  }

  let expectedStat
  for (let i = 1; i <= segments.length; i++) {
    const candidateStat = await lstat(path.join(root, ...segments.slice(0, i)))
    if (candidateStat.isSymbolicLink()) {
      throw new Error(`Source archive path contains a symbolic link: ${relativePath}`)
    }
    if (i === segments.length) expectedStat = candidateStat
  }
  if (!expectedStat?.isFile())
    throw new Error(`Source archive entry is not a file: ${relativePath}`)

  const absolutePath = path.join(root, ...segments)
  const noFollowFlag = constants.O_NOFOLLOW ?? 0
  const fileHandle = await open(absolutePath, constants.O_RDONLY | noFollowFlag)
  try {
    const openedStat = await fileHandle.stat()
    if (!openedStat.isFile() || !isSameFileSnapshot(expectedStat, openedStat)) {
      throw new Error(`Source archive entry changed while opening: ${relativePath}`)
    }

    const contents = await fileHandle.readFile()
    const completedStat = await fileHandle.stat()
    if (contents.byteLength !== openedStat.size || !isSameFileSnapshot(openedStat, completedStat)) {
      throw new Error(`Source archive entry changed while reading: ${relativePath}`)
    }
    return contents
  } finally {
    await fileHandle.close()
  }
}

export async function createImageSourceArchive(root = defaultRoot) {
  const files = await collectSourceFiles(root)
  const sourceEntries = []
  for (const relativePath of files) {
    sourceEntries.push({
      relativePath,
      contents: await readVerifiedSourceFile(root, relativePath),
    })
  }
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

  for (const entry of sourceEntries) {
    archive.append(entry.contents, {
      name: `chatgptbox-image-support/${entry.relativePath.replaceAll('\\', '/')}`,
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
