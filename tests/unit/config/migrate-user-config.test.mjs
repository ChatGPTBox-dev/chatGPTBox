import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { getUserConfig } from '../../../src/config/index.mjs'

function createCustomApiMode(overrides = {}) {
  return {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'custom-model',
    customUrl: '',
    apiKey: '',
    providerId: '',
    active: true,
    ...overrides,
  }
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('getUserConfig promotes legacy customUrl into custom provider and migrates legacy custom key', async () => {
  const customUrl = 'https://proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiKey: 'legacy-custom-key',
    customApiModes: [
      createCustomApiMode({
        customName: 'My Proxy',
        customUrl,
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'My Proxy')
  const migratedProvider = config.customOpenAIProviders.find(
    (provider) => provider.id === migratedMode.providerId,
  )

  assert.equal(Boolean(migratedMode.providerId), true)
  assert.equal(migratedMode.customUrl, '')
  assert.equal(migratedProvider.chatCompletionsUrl, customUrl)
  assert.equal(config.providerSecrets[migratedMode.providerId], 'legacy-custom-key')
})

test('getUserConfig reuses custom mode key promoted earlier in the same migration pass', async () => {
  const customUrl = 'https://proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      createCustomApiMode({
        customName: 'Legacy Custom Key',
        apiKey: 'legacy-custom-key',
      }),
      createCustomApiMode({
        customName: 'URL Proxy',
        customUrl,
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'URL Proxy')

  assert.equal(config.providerSecrets['legacy-custom-default'], 'legacy-custom-key')
  assert.equal(config.providerSecrets[migratedMode.providerId], 'legacy-custom-key')
})

test('getUserConfig reuses custom mode key promoted later in the same migration pass', async () => {
  const customUrl = 'https://proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      createCustomApiMode({
        customName: 'URL Proxy',
        customUrl,
      }),
      createCustomApiMode({
        customName: 'Legacy Custom Key',
        apiKey: 'legacy-custom-key',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'URL Proxy')

  assert.equal(config.providerSecrets['legacy-custom-default'], 'legacy-custom-key')
  assert.equal(config.providerSecrets[migratedMode.providerId], 'legacy-custom-key')
})

test('getUserConfig reuses custom mode key for selected customUrl migration in the same pass', async () => {
  const customUrl = 'https://selected-proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      createCustomApiMode({
        customName: 'Legacy Custom Key',
        apiKey: 'legacy-custom-key',
      }),
    ],
    apiMode: createCustomApiMode({
      customName: 'Selected URL Proxy',
      customUrl,
    }),
  })

  const config = await getUserConfig()

  assert.equal(config.providerSecrets['legacy-custom-default'], 'legacy-custom-key')
  assert.equal(config.providerSecrets[config.apiMode.providerId], 'legacy-custom-key')
})

test('getUserConfig reuses selected custom mode key for earlier customUrl migration', async () => {
  const customUrl = 'https://proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      createCustomApiMode({
        customName: 'URL Proxy',
        customUrl,
      }),
    ],
    apiMode: createCustomApiMode({
      customName: 'Selected Legacy Custom Key',
      apiKey: 'legacy-custom-key',
    }),
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'URL Proxy')

  assert.equal(config.providerSecrets['legacy-custom-default'], 'legacy-custom-key')
  assert.equal(config.providerSecrets[migratedMode.providerId], 'legacy-custom-key')
})

test('getUserConfig keeps raw-id provider secret when custom provider id is renamed', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      OpenAI: 'custom-provider-secret',
      openai: 'builtin-provider-secret',
    },
    customOpenAIProviders: [
      {
        id: 'OpenAI',
        name: 'My OpenAI Proxy',
        chatCompletionsUrl: 'https://custom.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'proxy-mode',
        providerId: 'OpenAI',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'My OpenAI Proxy',
  )
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'proxy-mode')

  assert.equal(migratedProvider.id, 'openai-2')
  assert.equal(migratedMode.providerId, 'openai-2')
  assert.equal(config.providerSecrets.openai, 'builtin-provider-secret')
  assert.equal(config.providerSecrets['openai-2'], 'custom-provider-secret')
})

test('getUserConfig preserves normalized sourceProviderId on custom providers', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'Selected Mode OpenAI',
        name: 'Selected Mode OpenAI',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        sourceProviderId: ' OpenAI ',
      },
    ],
  })

  const config = await getUserConfig()
  const migratedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Selected Mode OpenAI',
  )

  assert.equal(migratedProvider.sourceProviderId, 'openai')
})

test('getUserConfig persists normalization-only sourceProviderId migrations', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'Selected Mode OpenAI',
        name: 'Selected Mode OpenAI',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        sourceProviderId: ' OpenAI ',
      },
    ],
  })

  await getUserConfig()
  const storedConfig = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  const storedProvider = storedConfig.customOpenAIProviders.find(
    (provider) => provider.name === 'Selected Mode OpenAI',
  )

  assert.equal(storedProvider.sourceProviderId, 'openai')
})

test('getUserConfig remaps preserved custom sourceProviderId when provider ids are renamed', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: '',
        name: 'Generated Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
      {
        id: 'custom-provider-1',
        name: 'Renamed Proxy',
        chatCompletionsUrl: 'https://proxy2.example.com/v1/chat/completions',
      },
      {
        id: 'Selected Mode Proxy',
        name: 'Selected Mode Proxy',
        chatCompletionsUrl: 'https://proxy3.example.com/v1/chat/completions',
        sourceProviderId: 'custom-provider-1',
      },
    ],
  })

  const config = await getUserConfig()
  const migratedRenamedSourceProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Renamed Proxy',
  )
  const migratedMaterializedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Selected Mode Proxy',
  )

  assert.equal(migratedRenamedSourceProvider.id, 'custom-provider-1-2')
  assert.equal(migratedMaterializedProvider.sourceProviderId, 'custom-provider-1-2')
})

test('getUserConfig preserves builtin sourceProviderId when unrelated custom provider collides', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'OpenAI',
        name: 'My OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
      {
        id: 'Selected Mode OpenAI',
        name: 'Selected Mode OpenAI',
        chatCompletionsUrl: 'https://proxy2.example.com/v1/chat/completions',
        sourceProviderId: 'openai',
      },
    ],
  })

  const config = await getUserConfig()
  const migratedCollidingProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'My OpenAI Proxy',
  )
  const migratedMaterializedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Selected Mode OpenAI',
  )

  assert.equal(migratedCollidingProvider.id, 'openai-2')
  assert.equal(migratedMaterializedProvider.sourceProviderId, 'openai')
})

test('getUserConfig remaps colliding custom sourceProviderId instead of treating it as builtin', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'OpenAI',
        name: 'My OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
      {
        id: 'Selected Mode OpenAI Clone',
        name: 'Selected Mode OpenAI Clone',
        chatCompletionsUrl: 'https://proxy2.example.com/v1/chat/completions',
        sourceProviderId: 'OpenAI',
      },
    ],
  })

  const config = await getUserConfig()
  const migratedCollidingProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'My OpenAI Proxy',
  )
  const migratedMaterializedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Selected Mode OpenAI Clone',
  )

  assert.equal(migratedCollidingProvider.id, 'openai-2')
  assert.equal(migratedMaterializedProvider.sourceProviderId, 'openai-2')
})

test('getUserConfig preserves unchanged duplicate raw-id sourceProviderId targets', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'foo',
        name: 'Primary Foo Proxy',
        chatCompletionsUrl: 'https://proxy-a.example.com/v1/chat/completions',
      },
      {
        id: 'foo',
        name: 'Duplicate Foo Proxy',
        chatCompletionsUrl: 'https://proxy-b.example.com/v1/chat/completions',
      },
      {
        id: 'Selected Mode Foo',
        name: 'Selected Mode Foo',
        chatCompletionsUrl: 'https://proxy-c.example.com/v1/chat/completions',
        sourceProviderId: 'foo',
      },
    ],
  })

  const config = await getUserConfig()
  const primaryProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Primary Foo Proxy',
  )
  const duplicateProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Duplicate Foo Proxy',
  )
  const migratedMaterializedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Selected Mode Foo',
  )

  assert.equal(primaryProvider.id, 'foo')
  assert.equal(duplicateProvider.id, 'foo-2')
  assert.equal(migratedMaterializedProvider.sourceProviderId, 'foo')
})

test('getUserConfig does not reuse builtin provider secret for renamed colliding custom provider', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      openai: 'builtin-provider-secret',
    },
    customOpenAIProviders: [
      {
        id: 'OpenAI',
        name: 'My OpenAI Proxy',
        chatCompletionsUrl: 'https://custom.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'proxy-mode',
        providerId: 'OpenAI',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'My OpenAI Proxy',
  )
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'proxy-mode')

  assert.equal(migratedProvider.id, 'openai-2')
  assert.equal(migratedMode.providerId, 'openai-2')
  assert.equal(config.providerSecrets.openai, 'builtin-provider-secret')
  assert.equal(config.providerSecrets['openai-2'], undefined)
})

test('getUserConfig keeps original secret when colliding custom provider raw id is already normalized', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      myproxy: 'shared-provider-secret',
    },
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'Primary Proxy',
        chatCompletionsUrl: 'https://primary.example.com/v1/chat/completions',
      },
      {
        id: 'myproxy',
        name: 'Duplicate Proxy',
        chatCompletionsUrl: 'https://duplicate.example.com/v1/chat/completions',
      },
    ],
  })

  const config = await getUserConfig()
  const primaryProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Primary Proxy',
  )
  const duplicateProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Duplicate Proxy',
  )

  assert.equal(primaryProvider.id, 'myproxy')
  assert.equal(duplicateProvider.id, 'myproxy-2')
  assert.equal(config.providerSecrets.myproxy, 'shared-provider-secret')
  assert.equal(config.providerSecrets['myproxy-2'], 'shared-provider-secret')
})

test('getUserConfig prefers normalized provider secret when raw alias is explicitly empty', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      'My Proxy': '',
      'my-proxy': 'normalized-provider-secret',
    },
    customOpenAIProviders: [
      {
        id: 'my-proxy',
        name: 'Primary Proxy',
        chatCompletionsUrl: 'https://primary.example.com/v1/chat/completions',
      },
      {
        id: ' My Proxy ',
        name: 'Duplicate Proxy',
        chatCompletionsUrl: 'https://duplicate.example.com/v1/chat/completions',
      },
    ],
  })

  const config = await getUserConfig()
  const duplicateProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'Duplicate Proxy',
  )

  assert.equal(duplicateProvider.id, 'my-proxy-2')
  assert.equal(config.providerSecrets['my-proxy'], 'normalized-provider-secret')
  assert.equal(config.providerSecrets['my-proxy-2'], 'normalized-provider-secret')
  assert.equal(Object.hasOwn(config.providerSecrets, 'My Proxy'), false)
})

test('getUserConfig keeps empty providerSecrets entry instead of restoring legacy key', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      openai: '',
    },
    apiKey: 'legacy-openai-key',
  })

  const config = await getUserConfig()

  assert.equal(config.providerSecrets.openai, '')
  assert.equal(config.apiKey, '')
})

test('getUserConfig migrates raw-id provider secret when provider id is normalized only', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      MyProxy: 'raw-provider-secret',
    },
    customOpenAIProviders: [
      {
        id: 'MyProxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'proxy-mode',
        providerId: 'MyProxy',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedProvider = config.customOpenAIProviders.find(
    (provider) => provider.name === 'My Proxy',
  )
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'proxy-mode')

  assert.equal(migratedProvider.id, 'myproxy')
  assert.equal(migratedMode.providerId, 'myproxy')
  assert.equal(config.providerSecrets.myproxy, 'raw-provider-secret')
})

test('getUserConfig trims whitespace when normalizing custom provider ids in modes', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      MyProxy: 'raw-provider-secret',
    },
    customOpenAIProviders: [
      {
        id: 'MyProxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'proxy-mode',
        providerId: ' myproxy ',
      }),
    ],
    apiMode: createCustomApiMode({
      customName: 'selected-proxy-mode',
      providerId: ' MyProxy ',
    }),
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'proxy-mode')

  assert.equal(migratedMode.providerId, 'myproxy')
  assert.equal(config.apiMode.providerId, 'myproxy')
  assert.equal(config.providerSecrets.myproxy, 'raw-provider-secret')
})

test('getUserConfig reuses existing custom provider when legacy customUrl only differs by trailing slash', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'mode-with-slash',
        customUrl: 'https://proxy.example.com/v1/chat/completions/',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'mode-with-slash')

  assert.equal(config.customOpenAIProviders.length, 1)
  assert.equal(migratedMode.providerId, 'myproxy')
  assert.equal(migratedMode.customUrl, '')
})

test('getUserConfig reuses existing custom provider for selected mode when legacy customUrl only differs by trailing slash', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    apiMode: createCustomApiMode({
      customName: 'selected-mode',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
    }),
  })

  const config = await getUserConfig()

  assert.equal(config.customOpenAIProviders.length, 1)
  assert.equal(config.apiMode.providerId, 'myproxy')
  assert.equal(config.apiMode.customUrl, '')
})

test('getUserConfig defaults custom provider allowLegacyResponseField to true when absent', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'proxy-mode',
        providerId: 'myproxy',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedProvider = config.customOpenAIProviders.find(
    (provider) => provider.id === 'myproxy',
  )

  assert.equal(migratedProvider.allowLegacyResponseField, true)
})

test('getUserConfig preserves explicit false allowLegacyResponseField on custom providers', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        allowLegacyResponseField: false,
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'proxy-mode',
        providerId: 'myproxy',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedProvider = config.customOpenAIProviders.find(
    (provider) => provider.id === 'myproxy',
  )

  assert.equal(migratedProvider.allowLegacyResponseField, false)
})

test('getUserConfig preserves distinct selected and listed custom mode apiKeys', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      myproxy: 'provider-level-key',
    },
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'mode-key-override',
        providerId: 'myproxy',
        apiKey: 'mode-level-key',
      }),
    ],
    apiMode: createCustomApiMode({
      customName: 'selected-mode-key-override',
      providerId: 'myproxy',
      apiKey: 'selected-mode-level-key',
    }),
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'mode-key-override')
  const selectedProviderId = config.apiMode.providerId

  assert.equal(config.providerSecrets.myproxy, 'provider-level-key')
  assert.notEqual(migratedMode.providerId, 'myproxy')
  assert.notEqual(selectedProviderId, 'myproxy')
  assert.notEqual(migratedMode.providerId, selectedProviderId)
  assert.equal(config.providerSecrets[migratedMode.providerId], 'mode-level-key')
  assert.equal(config.providerSecrets[selectedProviderId], 'selected-mode-level-key')
  assert.equal(migratedMode.apiKey, '')
  assert.equal(config.apiMode.apiKey, '')
})

test('getUserConfig splits conflicting custom mode apiKeys into separate providers', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'mode-a',
        providerId: 'myproxy',
        apiKey: 'key-a',
      }),
      createCustomApiMode({
        customName: 'mode-b',
        providerId: 'myproxy',
        apiKey: 'key-b',
      }),
    ],
    apiMode: createCustomApiMode({
      customName: 'mode-b',
      providerId: 'myproxy',
      apiKey: 'key-b',
    }),
  })

  const config = await getUserConfig()
  const modeA = config.customApiModes.find((mode) => mode.customName === 'mode-a')
  const modeB = config.customApiModes.find((mode) => mode.customName === 'mode-b')

  assert.equal(modeA.providerId, 'myproxy')
  assert.notEqual(modeB.providerId, 'myproxy')
  assert.equal(config.apiMode.providerId, modeB.providerId)
  assert.equal(config.providerSecrets.myproxy, 'key-a')
  assert.equal(config.providerSecrets[modeB.providerId], 'key-b')
  assert.equal(modeA.apiKey, '')
  assert.equal(modeB.apiKey, '')
  assert.equal(config.apiMode.apiKey, '')
})

test('getUserConfig materializes distinct providers for legacy custom default key conflicts', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customModelApiUrl: 'https://legacy.example.com/v1/chat/completions',
    customApiModes: [
      createCustomApiMode({
        customName: 'legacy-a',
        apiKey: 'key-a',
      }),
      createCustomApiMode({
        customName: 'legacy-b',
        apiKey: 'key-b',
      }),
    ],
    apiMode: createCustomApiMode({
      customName: 'legacy-b',
      apiKey: 'key-b',
    }),
  })

  const config = await getUserConfig()
  const modeA = config.customApiModes.find((mode) => mode.customName === 'legacy-a')
  const modeB = config.customApiModes.find((mode) => mode.customName === 'legacy-b')
  const materializedProvider = config.customOpenAIProviders.find(
    (provider) => provider.id === modeB.providerId,
  )

  assert.equal(modeA.providerId, 'legacy-custom-default')
  assert.notEqual(modeB.providerId, 'legacy-custom-default')
  assert.equal(config.apiMode.providerId, modeB.providerId)
  assert.equal(config.providerSecrets['legacy-custom-default'], 'key-a')
  assert.equal(config.providerSecrets[modeB.providerId], 'key-b')
  assert.equal(
    materializedProvider.chatCompletionsUrl,
    'https://legacy.example.com/v1/chat/completions',
  )
  assert.equal(modeA.apiKey, '')
  assert.equal(modeB.apiKey, '')
  assert.equal(config.apiMode.apiKey, '')
})

test('getUserConfig migrates custom mode apiKey into provider secret when provider secret is empty', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
    customApiModes: [
      createCustomApiMode({
        customName: 'mode-key-source',
        providerId: 'myproxy',
        apiKey: 'mode-level-key',
      }),
    ],
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find((mode) => mode.customName === 'mode-key-source')

  assert.equal(config.providerSecrets.myproxy, 'mode-level-key')
  assert.equal(migratedMode.apiKey, '')
})

test('getUserConfig keeps existing provider secret when imported legacy key differs', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      openai: 'existing-secret',
    },
    apiKey: 'imported-legacy-secret',
  })

  const config = await getUserConfig()

  assert.equal(config.providerSecrets.openai, 'existing-secret')
})

test('getUserConfig does not overwrite provider secret when imported legacy key is empty', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      openai: 'existing-secret',
    },
    apiKey: '',
  })

  const config = await getUserConfig()

  assert.equal(config.providerSecrets.openai, 'existing-secret')
})

test('getUserConfig clears non-custom mode providerId and migrates mode key to providerSecrets', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      {
        groupName: 'chatgptApiModelKeys',
        itemName: 'chatgptApi35',
        isCustom: false,
        customName: '',
        customUrl: '',
        apiKey: 'sk-from-mode',
        providerId: 'openai',
        active: true,
      },
    ],
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find(
    (mode) => mode.groupName === 'chatgptApiModelKeys' && mode.itemName === 'chatgptApi35',
  )

  assert.equal(migratedMode.providerId, '')
  assert.equal(migratedMode.apiKey, '')
  assert.equal(config.providerSecrets.openai, 'sk-from-mode')
})

test('getUserConfig keeps empty providerSecrets entry when migrating non-custom mode key', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    providerSecrets: {
      openai: '',
    },
    customApiModes: [
      {
        groupName: 'chatgptApiModelKeys',
        itemName: 'chatgptApi35',
        isCustom: false,
        customName: '',
        customUrl: '',
        apiKey: 'sk-from-mode',
        providerId: 'openai',
        active: true,
      },
    ],
  })

  const config = await getUserConfig()
  const migratedMode = config.customApiModes.find(
    (mode) => mode.groupName === 'chatgptApiModelKeys' && mode.itemName === 'chatgptApi35',
  )

  assert.equal(migratedMode.providerId, '')
  assert.equal(migratedMode.apiKey, '')
  assert.equal(config.providerSecrets.openai, '')
})

test('getUserConfig writes current config schema version during migration', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.configSchemaVersion, 1)
  assert.equal(storage.configSchemaVersion, 1)
})

test('getUserConfig creates separate providers when same URL has different API keys', async () => {
  const customUrl = 'https://proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      createCustomApiMode({
        customName: 'mode-a',
        customUrl,
        apiKey: 'key-a',
      }),
      createCustomApiMode({
        customName: 'mode-b',
        customUrl,
        apiKey: 'key-b',
      }),
    ],
  })

  const config = await getUserConfig()
  const modeA = config.customApiModes.find((mode) => mode.customName === 'mode-a')
  const modeB = config.customApiModes.find((mode) => mode.customName === 'mode-b')

  assert.notEqual(
    modeA.providerId,
    modeB.providerId,
    'modes with different keys should get separate providers',
  )
  assert.equal(config.providerSecrets[modeA.providerId], 'key-a')
  assert.equal(config.providerSecrets[modeB.providerId], 'key-b')
  assert.equal(config.customOpenAIProviders.length, 2)
})

test('getUserConfig does not merge keyless mode into keyed provider for same URL', async () => {
  const customUrl = 'https://proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      createCustomApiMode({
        customName: 'mode-keyed',
        customUrl,
        apiKey: 'key-a',
      }),
      createCustomApiMode({
        customName: 'mode-keyless',
        customUrl,
        apiKey: '',
      }),
    ],
  })

  const config = await getUserConfig()
  const keyedMode = config.customApiModes.find((mode) => mode.customName === 'mode-keyed')
  const keylessMode = config.customApiModes.find((mode) => mode.customName === 'mode-keyless')

  assert.notEqual(
    keyedMode.providerId,
    keylessMode.providerId,
    'keyless mode should not be merged into a keyed provider',
  )
  assert.equal(config.providerSecrets[keyedMode.providerId], 'key-a')
  assert.equal(config.providerSecrets[keylessMode.providerId] || '', '')
})

test('getUserConfig keeps selected keyless mode separate from keyed provider for same URL', async () => {
  const customUrl = 'https://proxy.example.com/v1/chat/completions'
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      createCustomApiMode({
        customName: 'mode-keyed',
        customUrl,
        apiKey: 'key-a',
      }),
    ],
    apiMode: createCustomApiMode({
      customName: 'selected-keyless',
      customUrl,
      apiKey: '',
    }),
  })

  const config = await getUserConfig()
  const keyedMode = config.customApiModes.find((mode) => mode.customName === 'mode-keyed')

  assert.notEqual(
    keyedMode.providerId,
    config.apiMode.providerId,
    'selected keyless mode should not reuse keyed provider',
  )
  assert.equal(config.providerSecrets[keyedMode.providerId], 'key-a')
  assert.equal(config.providerSecrets[config.apiMode.providerId] || '', '')
})

test('getUserConfig reverse-syncs providerSecrets to legacy fields for backward compatibility', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 0,
    customApiModes: [
      {
        groupName: 'chatgptApiModelKeys',
        itemName: 'chatgptApi35',
        isCustom: false,
        customName: '',
        customUrl: '',
        apiKey: 'sk-from-mode',
        providerId: '',
        active: true,
      },
    ],
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.providerSecrets.openai, 'sk-from-mode')
  assert.equal(storage.apiKey, 'sk-from-mode', 'legacy apiKey field should be reverse-synced')
})

test('getUserConfig converges missing provider migration keys when schema version is current', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 1,
  })

  await getUserConfig()
  const storageAfterFirst = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.deepEqual(storageAfterFirst.providerSecrets, {})
  assert.deepEqual(storageAfterFirst.customApiModes, [])
  assert.deepEqual(storageAfterFirst.customOpenAIProviders, [])

  const snapshot = JSON.stringify(storageAfterFirst)
  await getUserConfig()
  const storageAfterSecond = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(JSON.stringify(storageAfterSecond), snapshot)
})

test('getUserConfig persists generated custom provider ids when schema version is current', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 1,
    providerSecrets: {},
    customApiModes: [],
    customOpenAIProviders: [
      {
        name: 'Current Schema Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    ],
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.customOpenAIProviders[0].id, 'custom-provider-1')
  assert.equal(storage.customOpenAIProviders[0].id, 'custom-provider-1')
})

test('getUserConfig normalizes providerSecrets when legacy data is not a plain object', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 1,
    providerSecrets: ['invalid-shape'],
  })

  await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.deepEqual(storage.providerSecrets, {})
})
