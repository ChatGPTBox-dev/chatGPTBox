import archiver from 'archiver'
import fs from 'fs-extra'
import path from 'path'
import webpack from 'webpack'
import ProgressBarPlugin from 'progress-bar-webpack-plugin'
import CssMinimizerPlugin from 'css-minimizer-webpack-plugin'
import MiniCssExtractPlugin from 'mini-css-extract-plugin'
import TerserPlugin from 'terser-webpack-plugin'
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'

const outdir = 'build'

const __dirname = path.resolve()
const isProduction = process.argv[2] !== '--development' // --production and --analyze are both production
const isAnalyzing = process.argv[2] === '--analyze'

async function deleteOldDir() {
  await fs.rm(outdir, { recursive: true, force: true })
}

async function runWebpack(isWithoutKatex, isWithoutTiktoken, minimal, callback) {
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
      path: path.resolve(__dirname, outdir),
    },
    mode: isProduction ? 'production' : 'development',
    devtool: isProduction ? false : 'inline-source-map',
    optimization: {
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            output: { ascii_only: true },
          },
        }),
        new CssMinimizerPlugin(),
      ],
      concatenateModules: false,
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
            {
              loader: 'babel-loader',
              options: {
                presets: [
                  '@babel/preset-env',
                  {
                    plugins: ['@babel/plugin-transform-runtime'],
                  },
                ],
                plugins: [
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
            MiniCssExtractPlugin.loader,
            {
              loader: 'css-loader',
              options: {
                importLoaders: 1,
              },
            },
            {
              loader: 'sass-loader',
            },
          ],
        },
        {
          test: /\.less$/,
          use: [
            MiniCssExtractPlugin.loader,
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
            MiniCssExtractPlugin.loader,
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
  if (isProduction) compiler.run(callback)
  else compiler.watch({}, callback)
}

async function zipFolder(dir) {
  const output = fs.createWriteStream(`${dir}.zip`)
  const archive = archiver('zip', {
    zlib: { level: 9 },
  })
  archive.pipe(output)
  archive.directory(dir, false)
  await archive.finalize()
}

async function copyFiles(entryPoints, targetDir) {
  if (!fs.existsSync(targetDir)) await fs.mkdir(targetDir)
  await Promise.all(
    entryPoints.map(async (entryPoint) => {
      await fs.copy(entryPoint.src, `${targetDir}/${entryPoint.dst}`)
    }),
  )
}

async function finishOutput(outputDirSuffix) {
  const commonFiles = [
    { src: 'src/logo.png', dst: 'logo.png' },
    { src: 'src/rules.json', dst: 'rules.json' },

    { src: 'build/shared.js', dst: 'shared.js' },
    { src: 'build/content-script.css', dst: 'content-script.css' }, // shared

    { src: 'build/content-script.js', dst: 'content-script.js' },

    { src: 'build/background.js', dst: 'background.js' },

    { src: 'build/popup.js', dst: 'popup.js' },
    { src: 'build/popup.css', dst: 'popup.css' },
    { src: 'src/popup/index.html', dst: 'popup.html' },

    { src: 'build/IndependentPanel.js', dst: 'IndependentPanel.js' },
    { src: 'src/pages/IndependentPanel/index.html', dst: 'IndependentPanel.html' },
  ]

  // chromium only
  const chromiumOutputDir = `./${outdir}/chromium${outputDirSuffix}`
  await copyFiles(
    [...commonFiles, { src: 'src/manifest.json', dst: 'manifest.json' }],
    chromiumOutputDir,
  )
  if (isProduction) await zipFolder(chromiumOutputDir)
}

function generateWebpackCallback(finishOutputFunc) {
  return async function webpackCallback(err, stats) {
    if (err || stats.hasErrors()) {
      console.error(err || stats.toString())
      return
    }
    // console.log(stats.toString())

    await finishOutputFunc()
  }
}

async function build() {
  await deleteOldDir()
  // Build only full version with all features for Chrome
  await runWebpack(
    false,
    false,
    false,
    generateWebpackCallback(() => finishOutput('')),
  )
}

build()
