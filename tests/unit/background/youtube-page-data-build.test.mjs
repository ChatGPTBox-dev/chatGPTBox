import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { EsbuildPlugin } from 'esbuild-loader'
import webpack from 'webpack'
import { excludeFromBabel } from '../../../scripts/build-module-rules.mjs'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const sourcePath = path.join(projectRoot, 'src/background/youtube-page-data.mjs')
const functionNames = [
  'readYouTubeMainWorldPlayerResponse',
  'captureYouTubeMainWorldCaption',
  'readYouTubeInnertubeTranscript',
  'readYouTubeTranscriptPanel',
]

function compile(config) {
  return new Promise((resolve, reject) => {
    const compiler = webpack(config)
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError || stats?.hasErrors()) {
          reject(error || closeError || new Error(stats?.toString({ all: false, errors: true })))
          return
        }
        resolve()
      })
    })
  })
}

function createPageContext() {
  const context = {
    AbortController,
    TextEncoder,
    URL,
    clearTimeout,
    document: {
      body: null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    location: { href: 'https://www.youtube.com/watch?v=z7do1hhb6fE' },
    setTimeout,
  }
  context.globalThis = context
  return context
}

test('production webpack output keeps executeScript page functions self-contained', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'youtube-page-data-build-'))
  const entryPath = path.join(temporaryDirectory, 'entry.mjs')
  const outputPath = path.join(temporaryDirectory, 'bundle.js')
  const sourceUrl = new URL(`file://${sourcePath}`).href
  await writeFile(
    entryPath,
    `import { ${functionNames.join(', ')} } from ${JSON.stringify(sourceUrl)}\n` +
      `globalThis.__youtubePageFunctions = { ${functionNames.join(', ')} }\n`,
  )

  try {
    await compile({
      mode: 'production',
      devtool: false,
      entry: entryPath,
      output: { filename: 'bundle.js', path: temporaryDirectory },
      optimization: {
        minimizer: [new EsbuildPlugin({ target: 'es2017', legalComments: 'none' })],
      },
      module: {
        rules: [
          {
            test: /\.m?jsx?$/,
            exclude: excludeFromBabel,
            use: {
              loader: 'babel-loader',
              options: {
                babelrc: false,
                configFile: false,
                presets: ['@babel/preset-env'],
                plugins: [['@babel/plugin-transform-runtime']],
              },
            },
          },
        ],
      },
    })

    const bundleContext = {}
    bundleContext.globalThis = bundleContext
    vm.runInNewContext(await readFile(outputPath, 'utf8'), bundleContext)

    for (const name of functionNames) {
      const serialized = bundleContext.__youtubePageFunctions[name].toString()
      const restored = vm.runInNewContext(`(${serialized})`, createPageContext())
      assert.equal(typeof restored, 'function')
      try {
        await restored('z7do1hhb6fE', {}, 0, 1)
      } catch (error) {
        assert.notEqual(error?.name, 'ReferenceError', `${name}: ${error?.message}`)
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})
