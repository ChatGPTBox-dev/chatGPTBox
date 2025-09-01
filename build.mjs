import archiver from 'archiver'
import fs from 'fs-extra'
import path from 'path'
import webpack from 'webpack'
import os from 'os'
import ProgressBarPlugin from 'progress-bar-webpack-plugin'
import CssMinimizerPlugin from 'css-minimizer-webpack-plugin'
import MiniCssExtractPlugin from 'mini-css-extract-plugin'
import { EsbuildPlugin } from 'esbuild-loader'
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'

const outdir = 'build'

const __dirname = path.resolve()
const isProduction = process.argv[2] !== '--development' // --production and --analyze are both production
const isAnalyzing = process.argv[2] === '--analyze'
// Env helpers
function getBooleanEnv(val, defaultValue) {
  if (val == null) return defaultValue
  const s = String(val).trim().toLowerCase()
  if (s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off') {
    return false
  }
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') {
    return true
  }
  console.warn(`[build] Unknown boolean env value "${val}", defaulting to ${defaultValue}`)
  return defaultValue
}
// Default: parallel build ON unless explicitly disabled
const parallelBuild = getBooleanEnv(process.env.BUILD_PARALLEL, true)
const isWatchOnce = getBooleanEnv(process.env.BUILD_WATCH_ONCE, false)
// Cache compression control: default none; allow override via env
function parseCacheCompressionOption(envVal) {
  if (envVal == null) return undefined
  const v = String(envVal).trim().toLowerCase()
  if (v === '' || v === '0' || v === 'false' || v === 'none') return false
  if (v === 'gzip' || v === 'brotli') return v
  console.warn(`[build] Unknown BUILD_CACHE_COMPRESSION="${envVal}", defaulting to no compression`)
  return false
}
const cacheCompressionOption = parseCacheCompressionOption(process.env.BUILD_CACHE_COMPRESSION)
let cpuCount = 1
try {
  // os.cpus() returns an array in Node.js; guard with try/catch for portability
  cpuCount = Math.max(1, os.cpus().length || 1)
} catch {
  cpuCount = 1
}
function parseThreadWorkerCount(envValue, cpuCount) {
  const maxWorkers = Math.max(1, cpuCount - 1)
  if (envValue !== undefined && envValue !== null) {
    const rawStr = String(envValue).trim()
    if (/^[1-9]\d*$/.test(rawStr)) {
      const raw = Number(rawStr)
      if (raw > cpuCount) {
        console.warn(
          `[build] BUILD_THREAD_WORKERS=${raw} exceeds CPU count (${cpuCount}); capping to ${cpuCount}`,
        )
      }
      return Math.min(raw, cpuCount)
    }
    console.warn(`[build] Invalid BUILD_THREAD_WORKERS="${envValue}", defaulting to ${maxWorkers}`)
  }
  return maxWorkers
}
const threadWorkers = parseThreadWorkerCount(process.env.BUILD_THREAD_WORKERS, cpuCount)
// Thread-loader pool timeout constants (allow override via env)
let PRODUCTION_POOL_TIMEOUT_MS = 2000
if (process.env.BUILD_POOL_TIMEOUT) {
  const n = parseInt(process.env.BUILD_POOL_TIMEOUT, 10)
  if (Number.isFinite(n) && n > 0) {
    PRODUCTION_POOL_TIMEOUT_MS = n
  } else {
    console.warn(
      `[build] Invalid BUILD_POOL_TIMEOUT="${process.env.BUILD_POOL_TIMEOUT}", keep default ${PRODUCTION_POOL_TIMEOUT_MS}ms`,
    )
  }
}
// Enable threads by default; allow disabling via BUILD_THREAD=0/false/no/off
const enableThread = getBooleanEnv(process.env.BUILD_THREAD, true)

// Cache and resolve Sass implementation once per process
let sassImplPromise
async function getSassImplementation() {
  if (!sassImplPromise) {
    sassImplPromise = (async () => {
      try {
        const mod = await import('sass-embedded')
        return mod.default || mod
      } catch (e1) {
        try {
          const mod = await import('sass')
          return mod.default || mod
        } catch (e2) {
          console.error('[build] Failed to load sass-embedded:', e1 && e1.message ? e1.message : e1)
          console.error('[build] Failed to load sass:', e2 && e2.message ? e2.message : e2)
          throw new Error("No Sass implementation available. Install 'sass-embedded' or 'sass'.")
        }
      }
    })()
  }
  return sassImplPromise
}

async function deleteOldDir() {
  await fs.rm(outdir, { recursive: true, force: true })
}

async function runWebpack(isWithoutKatex, isWithoutTiktoken, minimal, sourceBuildDir, callback) {
  const shared = [
    'preact',
    'webextension-polyfill',
    '@primer/octicons-react',
    'react-bootstrap-icons',
    'countries-list',
    'i18next',
    'react-i18next',
    'react-tabs',
    './src/utils',
    './src/_locales/i18n-react',
  ]
  if (isWithoutKatex) shared.push('./src/components')

  const sassImpl = await getSassImplementation()

  const dirKey = path.basename(sourceBuildDir || outdir)
  const variantParts = [
    isWithoutKatex ? 'no-katex' : 'with-katex',
    isWithoutTiktoken ? 'no-tiktoken' : 'with-tiktoken',
    minimal ? 'minimal' : 'full',
    dirKey,
    isProduction ? 'prod' : 'dev',
  ]
  const variantId = variantParts.join('__')

  const compiler = webpack({
    entry: {
      'content-script': {
        import: './src/content-script/index.jsx',
        dependOn: 'shared',
      },
      background: {
        import: './src/background/index.mjs',
      },
      popup: {
        import: './src/popup/index.jsx',
        dependOn: 'shared',
      },
      IndependentPanel: {
        import: './src/pages/IndependentPanel/index.jsx',
        dependOn: 'shared',
      },
      shared: shared,
    },
    output: {
      filename: '[name].js',
      path: path.resolve(__dirname, sourceBuildDir || outdir),
    },
    mode: isProduction ? 'production' : 'development',
    devtool: isProduction ? false : 'cheap-module-source-map',
    cache: {
      type: 'filesystem',
      name: `webpack-${variantId}`,
      // Only include dimensions that affect module outputs to avoid
      // unnecessary cache invalidations across machines/CI runners
      version: JSON.stringify({ PROD: isProduction }),
      // default none; override via BUILD_CACHE_COMPRESSION=gzip|brotli
      compression: cacheCompressionOption ?? false,
      buildDependencies: {
        config: [
          path.resolve('build.mjs'),
          ...['package.json', 'package-lock.json']
            .map((p) => path.resolve(p))
            .filter((p) => fs.existsSync(p)),
        ],
      },
    },
    optimization: {
      minimizer: [
        // Use esbuild for JS minification (faster than Terser)
        new EsbuildPlugin({
          target: 'es2017',
          legalComments: 'none',
        }),
        // Use esbuild-based CSS minify via css-minimizer plugin
        new CssMinimizerPlugin({
          minify: CssMinimizerPlugin.esbuildMinify,
        }),
      ],
      concatenateModules: !isAnalyzing,
    },
    plugins: [
      minimal
        ? new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
          })
        : new webpack.ProvidePlugin({
            process: 'process/browser.js',
            Buffer: ['buffer', 'Buffer'],
          }),
      new ProgressBarPlugin({
        format: '  build [:bar] :percent (:elapsed seconds)',
        clear: false,
      }),
      new MiniCssExtractPlugin({
        filename: '[name].css',
      }),
      new BundleAnalyzerPlugin({
        analyzerMode: isAnalyzing ? 'static' : 'disable',
      }),
      ...(isWithoutKatex
        ? [
            new webpack.NormalModuleReplacementPlugin(/markdown\.jsx/, (result) => {
              if (result.request) {
                result.request = result.request.replace(
                  'markdown.jsx',
                  'markdown-without-katex.jsx',
                )
              }
            }),
          ]
        : []),
    ],
    resolve: {
      extensions: ['.jsx', '.mjs', '.js'],
      // Disable symlink resolution for consistent behavior/perf; note this can
      // affect `npm link`/pnpm workspaces during local development
      symlinks: false,
      alias: {
        parse5: path.resolve(__dirname, 'node_modules/parse5'),
        ...(minimal
          ? { buffer: path.resolve(__dirname, 'node_modules/buffer') }
          : {
              util: path.resolve(__dirname, 'node_modules/util'),
              buffer: path.resolve(__dirname, 'node_modules/buffer'),
              stream: 'stream-browserify',
              crypto: 'crypto-browserify',
            }),
      },
    },
    module: {
      rules: [
        {
          test: /\.m?jsx?$/,
          exclude: /(node_modules)/,
          resolve: {
            fullySpecified: false,
          },
          use: [
            ...(enableThread
              ? [
                  {
                    loader: 'thread-loader',
                    options: {
                      workers: threadWorkers,
                      // Ensure one-off dev build exits quickly
                      poolTimeout: isProduction
                        ? PRODUCTION_POOL_TIMEOUT_MS
                        : isWatchOnce
                        ? 0
                        : Infinity,
                    },
                  },
                ]
              : []),
            {
              loader: 'babel-loader',
              options: {
                cacheDirectory: true,
                cacheCompression: false,
                presets: ['@babel/preset-env'],
                plugins: [
                  ['@babel/plugin-transform-runtime'],
                  [
                    '@babel/plugin-transform-react-jsx',
                    {
                      runtime: 'automatic',
                      importSource: 'preact',
                    },
                  ],
                ],
              },
            },
          ],
        },
        {
          test: /\.s[ac]ss$/,
          use: [
            isProduction ? MiniCssExtractPlugin.loader : 'style-loader',
            {
              loader: 'css-loader',
              options: {
                importLoaders: 1,
              },
            },
            {
              loader: 'sass-loader',
              options: { implementation: sassImpl },
            },
          ],
        },
        {
          test: /\.less$/,
          use: [
            isProduction ? MiniCssExtractPlugin.loader : 'style-loader',
            {
              loader: 'css-loader',
              options: {
                importLoaders: 1,
              },
            },
            {
              loader: 'less-loader',
            },
          ],
        },
        {
          test: /\.css$/,
          use: [
            isProduction ? MiniCssExtractPlugin.loader : 'style-loader',
            {
              loader: 'css-loader',
            },
          ],
        },
        {
          test: /\.(woff|ttf)$/,
          type: 'asset/resource',
          generator: {
            emit: false,
          },
        },
        {
          test: /\.woff2$/,
          type: 'asset/inline',
        },
        {
          test: /\.(jpg|png|svg)$/,
          type: 'asset/inline',
        },
        {
          test: /\.(graphql|gql)$/,
          loader: 'graphql-tag/loader',
        },
        isWithoutTiktoken
          ? {
              test: /crop-text\.mjs$/,
              loader: 'string-replace-loader',
              options: {
                multiple: [
                  {
                    search: "import { encode } from '@nem035/gpt-3-encoder'",
                    replace: '',
                  },
                  {
                    search: 'encode(',
                    replace: 'String(',
                  },
                ],
              },
            }
          : {},
        minimal
          ? {
              test: /styles\.scss$/,
              loader: 'string-replace-loader',
              options: {
                multiple: [
                  {
                    search: "@import '../fonts/styles.css';",
                    replace: '',
                  },
                ],
              },
            }
          : {},
        minimal
          ? {
              test: /index\.mjs$/,
              loader: 'string-replace-loader',
              options: {
                multiple: [
                  {
                    search: 'import { generateAnswersWithChatGLMApi }',
                    replace: '//',
                  },
                  {
                    search: 'await generateAnswersWithChatGLMApi',
                    replace: '//',
                  },
                ],
              },
            }
          : {},
      ],
    },
  })
  if (isProduction) {
    // Ensure compiler is properly closed after production runs
    compiler.run((err, stats) => {
      const finishClose = () =>
        compiler.close((closeErr) => {
          if (closeErr) {
            console.error('Error closing compiler:', closeErr)
            process.exitCode = 1
          }
        })
      try {
        const ret = callback(err, stats)
        if (ret && typeof ret.then === 'function') {
          ret.then(finishClose, finishClose)
        } else {
          finishClose()
        }
      } catch (_) {
        finishClose()
      }
    })
  } else {
    const watching = compiler.watch({}, (err, stats) => {
      const hasErrors = !!(
        err ||
        (stats && typeof stats.hasErrors === 'function' && stats.hasErrors())
      )
      // Normalize callback return into a Promise to catch synchronous throws
      const ret = Promise.resolve().then(() => callback(err, stats))
      if (isWatchOnce) {
        const finalize = (callbackFailed = false) =>
          watching.close((closeErr) => {
            if (closeErr) console.error('Error closing watcher:', closeErr)
            // Exit explicitly to prevent hanging processes in CI
            // Use non-zero exit code when errors occurred, including callback failures
            const shouldFail = hasErrors || closeErr || callbackFailed
            process.exit(shouldFail ? 1 : 0)
          })
        ret.then(
          () => finalize(false),
          () => finalize(true),
        )
      }
    })
  }
}

async function zipFolder(dir) {
  const zipPath = `${dir}.zip`
  await fs.ensureDir(path.dirname(zipPath))
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    let settled = false
    const fail = (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    }
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    output.once('error', fail)
    archive.once('error', fail)
    archive.on('warning', (err) => {
      // Log non-fatal archive warnings for diagnostics
      console.warn('[build][zip] warning:', err)
    })
    // Resolve on close to ensure FD is flushed and closed
    output.once('close', done)
    // Ensure close is emitted after finish on some fast runners
    output.once('finish', () => {
      try {
        if (typeof output.close === 'function') output.close()
      } catch (_) {
        // ignore
      }
    })
    archive.pipe(output)
    archive.directory(dir, false)
    archive.finalize()
  })
}

async function copyFiles(entryPoints, targetDir) {
  await fs.ensureDir(targetDir)
  await Promise.all(
    entryPoints.map(async (entryPoint) => {
      try {
        await fs.copy(entryPoint.src, `${targetDir}/${entryPoint.dst}`)
      } catch (e) {
        const isCss = String(entryPoint.dst).endsWith('.css')
        if (e && e.code === 'ENOENT') {
          if (!isProduction && isCss) {
            console.log(
              `[build] Skipping missing CSS file: ${entryPoint.src} -> ${entryPoint.dst} (placeholder will be created)`,
            )
            return
          }
          console.error('Missing build artifact:', `${entryPoint.src} -> ${entryPoint.dst}`)
        } else {
          console.error('Copy failed:', `${entryPoint.src} -> ${entryPoint.dst}`, e)
        }
        throw e
      }
    }),
  )
}

// In development, create placeholder CSS and sourcemap files to avoid 404 noise
async function ensureDevCssPlaceholders(targetDir) {
  if (isProduction) return
  const cssFiles = [path.join(targetDir, 'popup.css'), path.join(targetDir, 'content-script.css')]
  for (const cssPath of cssFiles) {
    if (!(await fs.pathExists(cssPath))) {
      await fs.outputFile(cssPath, '/* dev placeholder */\n')
    }
    const mapPath = `${cssPath}.map`
    if (!(await fs.pathExists(mapPath))) {
      await fs.outputFile(mapPath, '{"version":3,"sources":[],"mappings":"","names":[]}')
    }
  }
}

async function finishOutput(outputDirSuffix, sourceBuildDir = outdir) {
  const commonFiles = [
    { src: 'src/logo.png', dst: 'logo.png' },
    { src: 'src/rules.json', dst: 'rules.json' },

    { src: `${sourceBuildDir}/shared.js`, dst: 'shared.js' },
    { src: `${sourceBuildDir}/content-script.css`, dst: 'content-script.css' }, // shared

    { src: `${sourceBuildDir}/content-script.js`, dst: 'content-script.js' },

    { src: `${sourceBuildDir}/background.js`, dst: 'background.js' },

    { src: `${sourceBuildDir}/popup.js`, dst: 'popup.js' },
    { src: `${sourceBuildDir}/popup.css`, dst: 'popup.css' },
    { src: 'src/popup/index.html', dst: 'popup.html' },

    { src: `${sourceBuildDir}/IndependentPanel.js`, dst: 'IndependentPanel.js' },
    { src: 'src/pages/IndependentPanel/index.html', dst: 'IndependentPanel.html' },
    // Dev-only: copy external source maps for CSP-safe debugging
    ...(isProduction
      ? []
      : [
          { src: `${sourceBuildDir}/shared.js.map`, dst: 'shared.js.map' },
          { src: `${sourceBuildDir}/content-script.js.map`, dst: 'content-script.js.map' },
          { src: `${sourceBuildDir}/background.js.map`, dst: 'background.js.map' },
          { src: `${sourceBuildDir}/popup.js.map`, dst: 'popup.js.map' },
          { src: `${sourceBuildDir}/IndependentPanel.js.map`, dst: 'IndependentPanel.js.map' },
        ]),
  ]

  // chromium
  const chromiumOutputDir = `./${outdir}/chromium${outputDirSuffix}`
  await copyFiles(
    [...commonFiles, { src: 'src/manifest.json', dst: 'manifest.json' }],
    chromiumOutputDir,
  )
  await ensureDevCssPlaceholders(chromiumOutputDir)
  if (isProduction) await zipFolder(chromiumOutputDir)

  // firefox
  const firefoxOutputDir = `./${outdir}/firefox${outputDirSuffix}`
  await copyFiles(
    [...commonFiles, { src: 'src/manifest.v2.json', dst: 'manifest.json' }],
    firefoxOutputDir,
  )
  await ensureDevCssPlaceholders(firefoxOutputDir)
  if (isProduction) await zipFolder(firefoxOutputDir)
}

async function build() {
  await deleteOldDir()
  function createWebpackBuildPromise(isWithoutKatex, isWithoutTiktoken, minimal, tmpDir, suffix) {
    return new Promise((resolve, reject) => {
      const ret = runWebpack(
        isWithoutKatex,
        isWithoutTiktoken,
        minimal,
        tmpDir,
        async (err, stats) => {
          if (err || (stats && typeof stats.hasErrors === 'function' && stats.hasErrors())) {
            console.error(err || stats.toString())
            reject(err || new Error('webpack error'))
            return
          }
          try {
            await finishOutput(suffix, tmpDir)
            resolve()
          } catch (copyErr) {
            reject(copyErr)
          }
        },
      )
      // runWebpack is async; catch early rejections (e.g., failed dynamic imports)
      if (ret && typeof ret.then === 'function') ret.catch(reject)
    })
  }
  if (isProduction && !isAnalyzing) {
    const tmpFull = `${outdir}/.tmp-full`
    const tmpMin = `${outdir}/.tmp-min`
    try {
      if (parallelBuild) {
        await Promise.all([
          createWebpackBuildPromise(true, true, true, tmpMin, '-without-katex-and-tiktoken'),
          createWebpackBuildPromise(false, false, false, tmpFull, ''),
        ])
      } else {
        await createWebpackBuildPromise(true, true, true, tmpMin, '-without-katex-and-tiktoken')
        await createWebpackBuildPromise(false, false, false, tmpFull, '')
      }
    } finally {
      await fs.rm(tmpFull, { recursive: true, force: true })
      await fs.rm(tmpMin, { recursive: true, force: true })
    }
    return
  }

  await new Promise((resolve, reject) => {
    const ret = runWebpack(false, false, false, outdir, async (err, stats) => {
      const hasErrors = !!(
        err ||
        (stats && typeof stats.hasErrors === 'function' && stats.hasErrors())
      )
      if (hasErrors) {
        console.error(err || stats.toString())
        // In normal dev watch, keep process alive on initial errors; only fail when watch-once
        if (isWatchOnce) {
          reject(err || new Error('webpack error'))
        }
        return
      }
      try {
        await finishOutput('')
        resolve()
      } catch (e) {
        // Packaging failure should stop even in dev to avoid silent success
        reject(e)
      }
    })
    // Early setup failures (e.g., dynamic imports) should fail fast
    if (ret && typeof ret.then === 'function') ret.catch(reject)
  })
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})
