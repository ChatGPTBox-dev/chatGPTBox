import assert from 'node:assert/strict'
import { test } from 'node:test'

const shim = globalThis.__TEST_BROWSER_SHIM__

const { getUserConfig, setUserConfig } = await import('../../../src/config/index.mjs')

// Runs in its own process, and only after the import, so this drops the config
// module's own listener. The real storage event can arrive after the write
// resolves, so setUserConfig invalidates the cache itself; with no listener left,
// only that explicit invalidation can keep the next read from serving the
// previous config.
shim.resetStorageEvents()

test('setUserConfig invalidates the cache without any storage event', async () => {
  shim.setStorage({ modelName: 'gpt-4o' })
  assert.equal((await getUserConfig()).modelName, 'gpt-4o')

  await setUserConfig({ modelName: 'gpt-4o-mini' })

  assert.equal((await getUserConfig()).modelName, 'gpt-4o-mini')
})
