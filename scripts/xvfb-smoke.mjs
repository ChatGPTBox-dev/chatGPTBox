// Compatibility name: native headless browsers no longer require Xvfb.
import process from 'node:process'
import { run } from './smoke/runner.mjs'

process.exitCode = await run(process.argv.slice(2))
