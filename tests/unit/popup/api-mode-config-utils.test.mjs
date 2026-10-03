import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultApiModeIds } from '../../../src/config/index.mjs'
import {
  buildApiModeListConfigUpdate,
  expandApiModeListConfigUpdate,
  getSelectionPatchWhenApiModeDisabled,
} from '../../../src/popup/api-mode-config-utils.mjs'
import { modelNameToApiMode } from '../../../src/utils/model-name-convert.mjs'
import {
  buildConfigRollbackPatch,
  mergeConfigUpdate,
} from '../../../src/popup/popup-config-utils.mjs'

test('buildApiModeListConfigUpdate materializes the list with the current default baseline', () => {
  const nextApiModes = [{ itemName: 'chatgptFree35', active: true }]
  const result = buildApiModeListConfigUpdate(
    {
      knownApiModeDefaultIds: ['retired-default'],
    },
    nextApiModes,
    {
      selectionPatch: {
        modelName: 'customModel',
        apiMode: null,
      },
    },
  )

  assert.deepEqual(result, {
    modelName: 'customModel',
    apiMode: null,
    activeApiModes: [],
    customApiModes: nextApiModes,
    knownApiModeDefaultIds: ['retired-default', ...defaultApiModeIds],
  })
})

test('getSelectionPatchWhenApiModeDisabled preserves canonicalized legacy fallbacks', () => {
  const selectedApiMode = modelNameToApiMode('chatgptFree35')
  const fallbacks = [
    {
      modelName: 'ollamaModel',
      ollamaModelName: 'llama4',
      apiMode: modelNameToApiMode('ollamaModel-llama4'),
    },
    {
      modelName: 'azureOpenAi',
      azureDeploymentName: 'deploy-a',
      apiMode: modelNameToApiMode('azureOpenAi-deploy-a'),
    },
  ]

  for (const fallback of fallbacks) {
    const config = {
      ...fallback,
      apiMode: selectedApiMode,
    }
    assert.deepEqual(
      getSelectionPatchWhenApiModeDisabled(
        selectedApiMode,
        [fallback.apiMode, selectedApiMode],
        config,
      ),
      {
        modelName: fallback.modelName,
        apiMode: null,
      },
    )
  }
})

test('getSelectionPatchWhenApiModeDisabled clears a disabled legacy fallback', () => {
  const fallbackApiMode = modelNameToApiMode('ollamaModel-llama4')
  const config = {
    modelName: 'ollamaModel',
    ollamaModelName: 'llama4',
    apiMode: fallbackApiMode,
  }

  assert.deepEqual(
    getSelectionPatchWhenApiModeDisabled(fallbackApiMode, [fallbackApiMode], config),
    {
      modelName: 'customModel',
      apiMode: null,
    },
  )
})

test('getSelectionPatchWhenApiModeDisabled preserves duplicate custom fallbacks', () => {
  const selectedApiMode = modelNameToApiMode('chatgptFree35')
  const fallbackApiMode = modelNameToApiMode('customApiModelKeys-shared-model')
  const config = {
    modelName: 'customApiModelKeys-shared-model',
    apiMode: selectedApiMode,
  }

  assert.deepEqual(
    getSelectionPatchWhenApiModeDisabled(
      selectedApiMode,
      [
        { ...fallbackApiMode, providerId: 'provider-a' },
        { ...fallbackApiMode, providerId: 'provider-b' },
        selectedApiMode,
      ],
      config,
    ),
    {
      modelName: config.modelName,
      apiMode: null,
    },
  )
})

test('expandApiModeListConfigUpdate fills the complete atomic list bundle', () => {
  const currentConfig = {
    activeApiModes: [],
    customApiModes: [{ itemName: 'old-mode' }],
    knownApiModeDefaultIds: ['known-mode'],
    modelName: 'old-mode',
    apiMode: { itemName: 'old-mode' },
    themeMode: 'light',
  }

  const result = expandApiModeListConfigUpdate(currentConfig, {
    customApiModes: [{ itemName: 'new-mode' }],
  })

  assert.deepEqual(result, {
    activeApiModes: [],
    customApiModes: [{ itemName: 'new-mode' }],
    knownApiModeDefaultIds: ['known-mode'],
  })
})

test('expandApiModeListConfigUpdate fills the selection bundle when explicitly updated', () => {
  const currentConfig = {
    activeApiModes: [],
    customApiModes: [{ itemName: 'old-mode' }],
    knownApiModeDefaultIds: ['known-mode'],
    modelName: 'old-mode',
    apiMode: { itemName: 'old-mode' },
  }

  const result = expandApiModeListConfigUpdate(currentConfig, {
    customApiModes: [{ itemName: 'new-mode' }],
    apiMode: { itemName: 'new-mode' },
  })

  assert.deepEqual(result, {
    activeApiModes: [],
    customApiModes: [{ itemName: 'new-mode' }],
    knownApiModeDefaultIds: ['known-mode'],
    modelName: 'old-mode',
    apiMode: { itemName: 'new-mode' },
  })
})

test('expandApiModeListConfigUpdate leaves unrelated payloads unchanged', () => {
  const payload = { themeMode: 'dark' }
  assert.equal(expandApiModeListConfigUpdate({}, payload), payload)
})

test('a newer list request owns the complete atomic bundle after an earlier failure', () => {
  const persisted = {
    activeApiModes: [],
    customApiModes: [{ itemName: 'persisted' }],
    knownApiModeDefaultIds: ['persisted'],
    modelName: 'persisted',
    apiMode: { itemName: 'persisted' },
  }
  const requestA = expandApiModeListConfigUpdate(persisted, {
    customApiModes: [{ itemName: 'optimistic-a' }],
  })
  const optimisticA = mergeConfigUpdate(persisted, requestA)
  const requestB = expandApiModeListConfigUpdate(optimisticA, {
    customApiModes: [{ itemName: 'persisted-b' }],
  })
  const owners = Object.fromEntries(Object.keys(requestB).map((key) => [key, 2]))
  const rollbackA = buildConfigRollbackPatch(persisted, requestA, owners, 1)

  assert.deepEqual(rollbackA, {})
  assert.deepEqual(mergeConfigUpdate(optimisticA, requestB).customApiModes, [
    { itemName: 'persisted-b' },
  ])
})

test('a failed newer list request rolls the complete bundle back to the prior write', () => {
  const persisted = {
    activeApiModes: [],
    customApiModes: [{ itemName: 'persisted-a' }],
    knownApiModeDefaultIds: ['persisted-a'],
    modelName: 'persisted-a',
    apiMode: { itemName: 'persisted-a' },
  }
  const requestB = expandApiModeListConfigUpdate(persisted, {
    customApiModes: [{ itemName: 'optimistic-b' }],
  })
  const owners = Object.fromEntries(Object.keys(requestB).map((key) => [key, 2]))
  const rollbackB = buildConfigRollbackPatch(persisted, requestB, owners, 2)
  const optimisticB = mergeConfigUpdate(persisted, requestB)

  assert.deepEqual(mergeConfigUpdate(optimisticB, rollbackB), persisted)
})

test('a list request does not commit an earlier failed selection request', () => {
  const persisted = {
    activeApiModes: [],
    customApiModes: [{ itemName: 'persisted' }],
    knownApiModeDefaultIds: ['persisted'],
    modelName: 'persisted',
    apiMode: { itemName: 'persisted' },
  }
  const selectionRequest = {
    modelName: 'optimistic-selection',
    apiMode: { itemName: 'optimistic-selection' },
  }
  const optimisticSelection = mergeConfigUpdate(persisted, selectionRequest)
  const listRequest = expandApiModeListConfigUpdate(optimisticSelection, {
    customApiModes: [{ itemName: 'persisted-list' }],
  })
  const owners = {
    modelName: 1,
    apiMode: 1,
    ...Object.fromEntries(Object.keys(listRequest).map((key) => [key, 2])),
  }
  const selectionRollback = buildConfigRollbackPatch(persisted, selectionRequest, owners, 1)
  const optimisticList = mergeConfigUpdate(optimisticSelection, listRequest)

  assert.deepEqual(selectionRollback, {
    modelName: 'persisted',
    apiMode: { itemName: 'persisted' },
  })
  assert.equal(Object.hasOwn(listRequest, 'modelName'), false)
  assert.equal(Object.hasOwn(listRequest, 'apiMode'), false)
  assert.deepEqual(mergeConfigUpdate(optimisticList, selectionRollback), {
    ...persisted,
    customApiModes: [{ itemName: 'persisted-list' }],
  })
})
