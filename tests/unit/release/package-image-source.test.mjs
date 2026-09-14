import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  collectSourceFiles,
  isSensitiveSourcePath,
} from '../../../scripts/package-image-source.mjs'

test('source package collector only includes allowlisted roots and rejects secrets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatgptbox-source-'))
  t.after(() => rm(root, { force: true, recursive: true }))

  await Promise.all([
    mkdir(path.join(root, 'src'), { recursive: true }),
    mkdir(path.join(root, 'build'), { recursive: true }),
    mkdir(path.join(root, 'notes'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(root, 'README.md'), 'public'),
    writeFile(path.join(root, 'package.json'), '{}'),
    writeFile(path.join(root, '.env'), 'TOKEN=private'),
    writeFile(path.join(root, 'src', 'index.js'), 'export {}'),
    writeFile(path.join(root, 'src', '.env.local'), 'TOKEN=private'),
    writeFile(path.join(root, 'src', 'credentials.json'), '{}'),
    writeFile(path.join(root, 'src', 'private.pem'), 'private'),
    writeFile(path.join(root, 'build', 'artifact.zip'), 'generated'),
    writeFile(path.join(root, 'notes', 'local.txt'), 'untracked'),
  ])

  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync(
    'git',
    ['add', '--', 'README.md', 'package.json', 'src/index.js', 'src/private.pem'],
    { cwd: root },
  )
  await Promise.all(
    ['token.json', 'api-key.json', 'config.json', 'arbitrary-private.json'].map((name) =>
      writeFile(path.join(root, 'src', name), 'private'),
    ),
  )
  execFileSync('git', ['add', '--', 'src/token.json', 'src/api-key.json', 'src/config.json'], {
    cwd: root,
  })
  assert.deepEqual(await collectSourceFiles(root), ['README.md', 'package.json', 'src/index.js'])
  assert.equal(isSensitiveSourcePath('src/.env.production'), true)
  assert.equal(isSensitiveSourcePath('.npmrc'), true)
  assert.equal(isSensitiveSourcePath('id_ed25519'), true)
  assert.equal(isSensitiveSourcePath('src/client.key'), true)
  assert.equal(isSensitiveSourcePath('src/credentials.json'), true)
  assert.equal(isSensitiveSourcePath('src/components/App.jsx'), false)
})
