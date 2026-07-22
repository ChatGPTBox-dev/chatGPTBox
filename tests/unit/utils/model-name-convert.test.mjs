import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apiModeToModelName,
  getApiModesFromConfig,
  getApiModesStringArrayFromConfig,
  getUniquelySelectedApiModeIndex,
  isApiModeSelected,
  isInApiModeGroup,
  isUsingModelName,
  modelNameToApiMode,
  modelNameToCustomPart,
  modelNameToDesc,
  modelNameToPresetPart,
  modelNameToValue,
  getModelValue,
  normalizeApiMode,
  reconcileMaterializedApiModeDefaults,
} from '../../../src/utils/model-name-convert.mjs'
import { ModelGroups } from '../../../src/config/index.mjs'

test('modelNameToApiMode and apiModeToModelName round-trip custom model names', () => {
  const modelName = 'bingFree4-fast'
  const apiMode = modelNameToApiMode(modelName)

  assert.equal(apiMode.groupName, 'bingWebModelKeys')
  assert.equal(apiMode.itemName, 'bingFree4')
  assert.equal(apiMode.isCustom, true)
  assert.equal(apiMode.customName, 'fast')
  assert.equal(apiModeToModelName(apiMode), modelName)
})

test('apiModeToModelName uses groupName prefix for AlwaysCustomGroups', () => {
  const apiMode = {
    groupName: 'azureOpenAiApiModelKeys',
    itemName: 'azureOpenAi',
    isCustom: true,
    customName: 'deployment-a',
    customUrl: '',
    apiKey: '',
    active: true,
  }

  assert.equal(apiModeToModelName(apiMode), 'azureOpenAiApiModelKeys-deployment-a')
})

test('getApiModesFromConfig merges active and custom API modes correctly', () => {
  const activeCustomMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: true,
    customName: 'fast',
    customUrl: '',
    apiKey: '',
    active: true,
  }

  const inactiveCustomMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFreeSydney',
    isCustom: true,
    customName: 'slow',
    customUrl: '',
    apiKey: '',
    active: false,
  }

  const config = {
    activeApiModes: ['chatgptFree35', 'customModel', 'azureOpenAi'],
    customApiModes: [activeCustomMode, inactiveCustomMode],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama4',
  }

  const onlyActive = getApiModesFromConfig(config, true)
  const allModes = getApiModesFromConfig(config, false)

  assert.equal(
    onlyActive.some((mode) => mode.itemName === 'chatgptFree35'),
    true,
  )
  assert.equal(
    onlyActive.some(
      (mode) => mode.groupName === 'azureOpenAiApiModelKeys' && mode.customName === 'deploy-a',
    ),
    true,
  )
  assert.equal(
    onlyActive.some((mode) => mode.itemName === 'bingFree4' && mode.customName === 'fast'),
    true,
  )
  assert.equal(
    onlyActive.some((mode) => mode.itemName === 'bingFreeSydney' && mode.customName === 'slow'),
    false,
  )

  assert.equal(
    allModes.some((mode) => mode.itemName === 'bingFreeSydney' && mode.customName === 'slow'),
    true,
  )
})

test('reconcileMaterializedApiModeDefaults appends unseen defaults in order', () => {
  const existingMode = modelNameToApiMode('chatgptFree35')
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [existingMode],
      azureDeploymentName: '',
      ollamaModelName: 'llama4',
    },
    ['chatgptFree35', 'claude2WebFree', 'moonshotWebFree'],
    ['chatgptFree35'],
  )

  assert.deepEqual(result.customApiModes.map(apiModeToModelName), [
    'chatgptFree35',
    'claude2WebFree',
    'moonshotWebFree',
  ])
  assert.deepEqual(result.knownApiModeDefaultIds, [
    'chatgptFree35',
    'claude2WebFree',
    'moonshotWebFree',
  ])
  assert.equal(result.changed, true)
})

test('reconcileMaterializedApiModeDefaults preserves an inactive equivalent row', () => {
  const inactiveMode = { ...modelNameToApiMode('claude2WebFree'), active: false }
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [inactiveMode],
      azureDeploymentName: '',
      ollamaModelName: 'llama4',
    },
    ['claude2WebFree'],
    [],
  )

  assert.equal(result.customApiModes.length, 1)
  assert.equal(result.customApiModes[0].active, false)
  assert.deepEqual(result.knownApiModeDefaultIds, ['claude2WebFree'])
})

test('reconcileMaterializedApiModeDefaults preserves exact duplicates without adding another row', () => {
  const duplicateMode = modelNameToApiMode('chatgptFree35')
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [duplicateMode, { ...duplicateMode }],
      azureDeploymentName: '',
      ollamaModelName: 'llama4',
    },
    ['chatgptFree35'],
    [],
  )

  assert.equal(result.customApiModes.length, 2)
  assert.deepEqual(result.knownApiModeDefaultIds, ['chatgptFree35'])
})

test('reconcileMaterializedApiModeDefaults keeps provider variants distinct from a default row', () => {
  const providerVariant = {
    ...modelNameToApiMode('chatgptFree35'),
    providerId: 'custom-provider',
  }
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [providerVariant],
      azureDeploymentName: '',
      ollamaModelName: 'llama4',
    },
    ['chatgptFree35'],
    [],
  )

  assert.equal(result.customApiModes.length, 2)
  assert.equal(result.customApiModes[0].providerId, 'custom-provider')
  assert.equal(result.customApiModes[1].providerId, '')
})

test('reconcileMaterializedApiModeDefaults is idempotent for known defaults', () => {
  const existingMode = modelNameToApiMode('chatgptFree35')
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [existingMode],
      azureDeploymentName: '',
      ollamaModelName: 'llama4',
    },
    ['chatgptFree35'],
    ['chatgptFree35'],
  )

  assert.deepEqual(result.customApiModes, [existingMode])
  assert.deepEqual(result.knownApiModeDefaultIds, ['chatgptFree35'])
  assert.equal(result.changed, false)
})

test('reconcileMaterializedApiModeDefaults resolves configured Azure and Ollama defaults', () => {
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [],
      azureDeploymentName: 'deployment-a',
      ollamaModelName: 'llama4',
    },
    ['azureOpenAi', 'ollamaModel'],
    [],
  )

  assert.deepEqual(result.customApiModes.map(apiModeToModelName), [
    'azureOpenAiApiModelKeys-deployment-a',
    'ollamaApiModelKeys-llama4',
  ])
})

test('reconcileMaterializedApiModeDefaults reuses legacy Azure and Ollama rows', () => {
  const legacyAzureMode = {
    ...modelNameToApiMode('azureOpenAi-deployment-a'),
    itemName: '',
    active: false,
  }
  const legacyOllamaMode = {
    ...modelNameToApiMode('ollamaModel-llama4'),
    itemName: '',
    active: false,
  }
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [legacyAzureMode, legacyOllamaMode],
      azureDeploymentName: 'deployment-a',
      ollamaModelName: 'llama4',
    },
    ['azureOpenAi', 'ollamaModel'],
    [],
  )

  assert.deepEqual(result.customApiModes, [legacyAzureMode, legacyOllamaMode])
  assert.deepEqual(result.knownApiModeDefaultIds, ['azureOpenAi', 'ollamaModel'])
})

test('reconcileMaterializedApiModeDefaults reuses UI-shaped Azure and Ollama rows', () => {
  const uiAzureMode = {
    ...modelNameToApiMode('azureOpenAi'),
    customName: 'deployment-a',
    active: false,
  }
  const uiOllamaMode = {
    ...modelNameToApiMode('ollamaModel'),
    customName: 'llama4',
    active: false,
  }
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [uiAzureMode, uiOllamaMode],
      azureDeploymentName: 'deployment-a',
      ollamaModelName: 'llama4',
    },
    ['azureOpenAi', 'ollamaModel'],
    [],
  )

  assert.deepEqual(result.customApiModes, [uiAzureMode, uiOllamaMode])
  assert.deepEqual(result.knownApiModeDefaultIds, ['azureOpenAi', 'ollamaModel'])
})

test('reconcileMaterializedApiModeDefaults reuses named rows with legacy item names', () => {
  const legacyAzureMode = {
    ...modelNameToApiMode('azureOpenAi'),
    itemName: 'azureOpenAiApiModelKeys',
    customName: 'deployment-a',
    active: false,
  }
  const legacyOllamaMode = {
    ...modelNameToApiMode('ollamaModel'),
    itemName: 'ollamaApiModelKeys',
    customName: 'llama4',
    active: false,
  }
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [legacyAzureMode, legacyOllamaMode],
      azureDeploymentName: 'deployment-a',
      ollamaModelName: 'llama4',
    },
    ['azureOpenAi', 'ollamaModel'],
    [],
  )

  assert.deepEqual(result.customApiModes, [legacyAzureMode, legacyOllamaMode])
  assert.deepEqual(result.knownApiModeDefaultIds, ['azureOpenAi', 'ollamaModel'])
})

test('getApiModesFromConfig keeps AlwaysCustomGroups modes when itemName is empty', () => {
  const config = {
    activeApiModes: ['customModel'],
    customApiModes: [
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'llama3.2',
        customUrl: '',
        apiKey: '',
        providerId: '',
        active: true,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama4',
  }

  const onlyActive = getApiModesFromConfig(config, true)

  assert.equal(
    onlyActive.some(
      (mode) => mode.groupName === 'ollamaApiModelKeys' && mode.customName === 'llama3.2',
    ),
    true,
  )
  assert.equal(apiModeToModelName(onlyActive[0]), 'ollamaApiModelKeys-llama3.2')
})

test('getApiModesFromConfig drops malformed non-custom custom API mode rows', () => {
  const allModes = getApiModesFromConfig(
    {
      activeApiModes: [],
      customApiModes: [
        {
          ...modelNameToApiMode('customModel'),
          active: true,
        },
        {
          groupName: 'azureOpenAiApiModelKeys',
          itemName: 'wrong-azure-preset',
          isCustom: false,
          customName: '',
          active: true,
        },
        {
          groupName: 'ollamaApiModelKeys',
          itemName: 'wrong-ollama-preset',
          isCustom: false,
          customName: '',
          active: true,
        },
      ],
      azureDeploymentName: '',
      ollamaModelName: '',
    },
    false,
  )

  assert.deepEqual(allModes, [])
})

test('getApiModesFromConfig drops nameless Azure row instead of hiding the legacy active mode', () => {
  const config = {
    activeApiModes: ['azureOpenAi'],
    customApiModes: [
      {
        groupName: 'azureOpenAiApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: '',
        customUrl: '',
        apiKey: '',
        providerId: 'blank-azure-provider',
        active: true,
      },
    ],
    azureDeploymentName: '',
    ollamaModelName: 'llama4',
  }

  const allModes = getApiModesFromConfig(config, false)
  const onlyActive = getApiModesFromConfig(config, true)

  assert.equal(
    allModes.some((mode) => mode.providerId === 'blank-azure-provider'),
    false,
  )
  assert.equal(
    allModes.some((mode) => mode.itemName === 'azureOpenAi'),
    true,
  )
  assert.equal(
    onlyActive.some((mode) => mode.itemName === 'azureOpenAi'),
    true,
  )
})

test('getApiModesFromConfig drops nameless Ollama row instead of hiding the legacy active mode', () => {
  const config = {
    activeApiModes: ['ollamaModel'],
    customApiModes: [
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: '',
        customUrl: '',
        apiKey: '',
        providerId: 'blank-ollama-provider',
        active: true,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: '',
  }

  const allModes = getApiModesFromConfig(config, false)
  const onlyActive = getApiModesFromConfig(config, true)

  assert.equal(
    allModes.some((mode) => mode.providerId === 'blank-ollama-provider'),
    false,
  )
  assert.equal(
    allModes.some((mode) => mode.itemName === 'ollamaModel'),
    true,
  )
  assert.equal(
    onlyActive.some((mode) => mode.itemName === 'ollamaModel'),
    true,
  )
})

test('getApiModesFromConfig keeps nameless built-in Azure and Ollama preset rows', () => {
  const config = {
    activeApiModes: [],
    customApiModes: [
      {
        ...modelNameToApiMode('azureOpenAi'),
        customName: '',
      },
      {
        ...modelNameToApiMode('ollamaModel'),
        customName: '',
      },
    ],
    azureDeploymentName: '',
    ollamaModelName: '',
  }

  const allModes = getApiModesFromConfig(config, false)

  assert.equal(
    allModes.some((mode) => mode.itemName === 'azureOpenAi'),
    true,
  )
  assert.equal(
    allModes.some((mode) => mode.itemName === 'ollamaModel'),
    true,
  )
})

test('reconcileMaterializedApiModeDefaults tolerates a non-string custom name', () => {
  const result = reconcileMaterializedApiModeDefaults(
    {
      customApiModes: [
        {
          ...modelNameToApiMode('chatgptFree35'),
          customName: 1,
        },
      ],
    },
    ['claude2WebFree'],
    [],
  )

  assert.equal(result.customApiModes.length, 2)
  assert.deepEqual(result.knownApiModeDefaultIds, ['claude2WebFree'])
})

test('getApiModesFromConfig deduplicates migrated Ollama legacy row against kept AlwaysCustomGroups mode', () => {
  const config = {
    activeApiModes: ['ollamaModel-llama3.2'],
    customApiModes: [
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'llama3.2',
        customUrl: '',
        apiKey: '',
        providerId: '',
        active: true,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama3.2',
  }

  const allModes = getApiModesFromConfig(config, false)
  assert.equal(
    allModes.filter((mode) => apiModeToModelName(mode) === 'ollamaApiModelKeys-llama3.2').length,
    1,
  )
})

test('getApiModesFromConfig preserves active state when inactive Ollama custom row matches active legacy mode', () => {
  const config = {
    activeApiModes: ['ollamaModel-llama3.2'],
    customApiModes: [
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'llama3.2',
        customUrl: 'http://localhost:11434/api/chat',
        apiKey: '',
        providerId: 'preserved-ollama-provider',
        sourceProviderId: 'ollama',
        active: false,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama3.2',
  }

  const allModes = getApiModesFromConfig(config, false)
  const onlyActive = getApiModesFromConfig(config, true)
  const preservedMode = allModes.find(
    (mode) => apiModeToModelName(mode) === 'ollamaApiModelKeys-llama3.2',
  )

  assert.equal(
    allModes.filter((mode) => apiModeToModelName(mode) === 'ollamaApiModelKeys-llama3.2').length,
    1,
  )
  assert.equal(preservedMode.active, true)
  assert.equal(preservedMode.itemName, 'ollamaModel')
  assert.equal(preservedMode.providerId, 'preserved-ollama-provider')
  assert.equal(preservedMode.customUrl, 'http://localhost:11434/api/chat')
  assert.equal(isApiModeSelected(preservedMode, { modelName: 'ollamaModel-llama3.2' }), true)
  assert.equal(
    onlyActive.some((mode) => apiModeToModelName(mode) === 'ollamaApiModelKeys-llama3.2'),
    true,
  )
})

test('getApiModesFromConfig keeps legacy Ollama row when multiple inactive custom providers share the same mode name', () => {
  const config = {
    activeApiModes: ['ollamaModel-llama3.2'],
    customApiModes: [
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'llama3.2',
        customUrl: 'http://ollama-a:11434/api/chat',
        apiKey: '',
        providerId: 'ollama-provider-a',
        sourceProviderId: 'ollama',
        active: false,
      },
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'llama3.2',
        customUrl: 'http://ollama-b:11434/api/chat',
        apiKey: '',
        providerId: 'ollama-provider-b',
        sourceProviderId: 'ollama',
        active: false,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama3.2',
  }

  const allModes = getApiModesFromConfig(config, false)
  const onlyActive = getApiModesFromConfig(config, true)
  const legacyMode = allModes.find(
    (mode) =>
      apiModeToModelName(mode) === 'ollamaApiModelKeys-llama3.2' &&
      mode.providerId === '' &&
      mode.itemName === 'ollamaModel',
  )

  assert.equal(
    allModes.filter((mode) => apiModeToModelName(mode) === 'ollamaApiModelKeys-llama3.2').length,
    3,
  )
  assert.equal(legacyMode.active, true)
  assert.equal(
    allModes.some((mode) => mode.providerId === 'ollama-provider-a' && mode.active),
    false,
  )
  assert.equal(
    allModes.some((mode) => mode.providerId === 'ollama-provider-b' && mode.active),
    false,
  )
  assert.equal(onlyActive.length, 1)
  assert.equal(onlyActive[0].providerId, '')
  assert.equal(onlyActive[0].itemName, 'ollamaModel')
})

test('getApiModesFromConfig does not add a legacy Ollama row when one matching custom provider is already active', () => {
  const config = {
    activeApiModes: ['ollamaModel-llama3.2'],
    customApiModes: [
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'llama3.2',
        customUrl: 'http://ollama-a:11434/api/chat',
        apiKey: '',
        providerId: 'ollama-provider-a',
        sourceProviderId: 'ollama',
        active: true,
      },
      {
        groupName: 'ollamaApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'llama3.2',
        customUrl: 'http://ollama-b:11434/api/chat',
        apiKey: '',
        providerId: 'ollama-provider-b',
        sourceProviderId: 'ollama',
        active: false,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama3.2',
  }

  const allModes = getApiModesFromConfig(config, false)
  const onlyActive = getApiModesFromConfig(config, true)
  const activeMode = allModes.find((mode) => mode.providerId === 'ollama-provider-a')
  const inactiveMode = allModes.find((mode) => mode.providerId === 'ollama-provider-b')

  assert.equal(
    allModes.filter((mode) => apiModeToModelName(mode) === 'ollamaApiModelKeys-llama3.2').length,
    2,
  )
  assert.equal(
    allModes.some((mode) => mode.providerId === '' && mode.itemName === 'ollamaModel'),
    false,
  )
  assert.equal(
    allModes.some((mode) => mode.providerId === 'ollama-provider-a' && mode.active),
    true,
  )
  assert.equal(
    allModes.some((mode) => mode.providerId === 'ollama-provider-b' && mode.active),
    false,
  )
  assert.equal(activeMode.itemName, 'ollamaModel')
  assert.equal(inactiveMode.itemName, '')
  assert.equal(isApiModeSelected(activeMode, { modelName: 'ollamaModel-llama3.2' }), true)
  assert.equal(isApiModeSelected(inactiveMode, { modelName: 'ollamaModel-llama3.2' }), false)
  assert.equal(onlyActive.length, 1)
  assert.equal(onlyActive[0].providerId, 'ollama-provider-a')
})

test('getApiModesFromConfig deduplicates migrated Azure legacy row against kept AlwaysCustomGroups mode', () => {
  const config = {
    activeApiModes: ['azureOpenAi-deploy-a'],
    customApiModes: [
      {
        groupName: 'azureOpenAiApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'deploy-a',
        customUrl: '',
        apiKey: '',
        providerId: '',
        active: true,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama4',
  }

  const allModes = getApiModesFromConfig(config, false)
  assert.equal(
    allModes.filter((mode) => apiModeToModelName(mode) === 'azureOpenAiApiModelKeys-deploy-a')
      .length,
    1,
  )
})

test('getApiModesFromConfig preserves active state when inactive Azure custom row matches active legacy mode', () => {
  const config = {
    activeApiModes: ['azureOpenAi-deploy-a'],
    customApiModes: [
      {
        groupName: 'azureOpenAiApiModelKeys',
        itemName: '',
        isCustom: true,
        customName: 'deploy-a',
        customUrl: 'https://azure.example.com/openai/deployments/deploy-a/chat/completions',
        apiKey: '',
        providerId: 'preserved-azure-provider',
        sourceProviderId: 'openai',
        active: false,
      },
    ],
    azureDeploymentName: 'deploy-a',
    ollamaModelName: 'llama4',
  }

  const allModes = getApiModesFromConfig(config, false)
  const onlyActive = getApiModesFromConfig(config, true)
  const preservedMode = allModes.find(
    (mode) => apiModeToModelName(mode) === 'azureOpenAiApiModelKeys-deploy-a',
  )

  assert.equal(
    allModes.filter((mode) => apiModeToModelName(mode) === 'azureOpenAiApiModelKeys-deploy-a')
      .length,
    1,
  )
  assert.equal(preservedMode.active, true)
  assert.equal(preservedMode.itemName, 'azureOpenAi')
  assert.equal(preservedMode.providerId, 'preserved-azure-provider')
  assert.equal(
    preservedMode.customUrl,
    'https://azure.example.com/openai/deployments/deploy-a/chat/completions',
  )
  assert.equal(isApiModeSelected(preservedMode, { modelName: 'azureOpenAi-deploy-a' }), true)
  assert.equal(
    onlyActive.some((mode) => apiModeToModelName(mode) === 'azureOpenAiApiModelKeys-deploy-a'),
    true,
  )
})

test('getApiModesFromConfig does not synthesize undefined legacy Azure or Ollama names', () => {
  const config = {
    activeApiModes: ['azureOpenAi', 'ollamaModel'],
    customApiModes: [],
    azureDeploymentName: '',
    ollamaModelName: '',
  }

  const allModes = getApiModesFromConfig(config, false)
  const onlyActive = getApiModesFromConfig(config, true)

  assert.equal(
    allModes.some((mode) => apiModeToModelName(mode).includes('undefined')),
    false,
  )
  assert.equal(
    onlyActive.some((mode) => apiModeToModelName(mode).includes('undefined')),
    false,
  )
  assert.equal(
    allModes.some((mode) => mode.itemName === 'azureOpenAi'),
    true,
  )
  assert.equal(
    allModes.some((mode) => mode.itemName === 'ollamaModel'),
    true,
  )
})

test('isUsingModelName matches base model for custom model names', () => {
  assert.equal(isUsingModelName('bingFree4', { modelName: 'bingFree4-fast' }), true)
  assert.equal(isUsingModelName('claude2WebFree', { modelName: 'chatgptFree35' }), false)

  const apiMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: true,
    customName: 'fast',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  assert.equal(isUsingModelName('bingFree4', { apiMode }), true)
})

test('modelNameToDesc returns desc for a known model name without t function', () => {
  const desc = modelNameToDesc('chatgptFree35')
  assert.equal(desc, 'ChatGPT (Web)')
})

test('modelNameToDesc returns desc for GPT-5 stable presets', () => {
  assert.equal(modelNameToDesc('chatgptApi5'), 'OpenAI (GPT-5)')
  assert.equal(modelNameToDesc('chatgptApi5_1'), 'OpenAI (GPT-5.1)')
  assert.equal(modelNameToDesc('chatgptApi5_2'), 'OpenAI (GPT-5.2)')
  assert.equal(modelNameToDesc('chatgptApi5_4'), 'OpenAI (GPT-5.4)')
  assert.equal(modelNameToDesc('chatgptApi5_4Mini'), 'OpenAI (GPT-5.4 mini)')
  assert.equal(modelNameToDesc('chatgptApi5_4Nano'), 'OpenAI (GPT-5.4 nano)')
  assert.equal(modelNameToDesc('chatgptApi5_5'), 'OpenAI (GPT-5.5)')
  assert.equal(modelNameToDesc('chatgptApi5_6'), 'OpenAI (GPT-5.6)')
  assert.equal(modelNameToDesc('chatgptApi5_6Sol'), 'OpenAI (GPT-5.6 Sol)')
  assert.equal(modelNameToDesc('chatgptApi5_6Terra'), 'OpenAI (GPT-5.6 Terra)')
  assert.equal(modelNameToDesc('chatgptApi5_6Luna'), 'OpenAI (GPT-5.6 Luna)')
})

test('modelNameToDesc appends extraCustomModelName for customModel', () => {
  const desc = modelNameToDesc('customModel', null, 'my-gpt')
  assert.equal(desc, 'Custom Model (my-gpt)')
})

test('modelNameToDesc returns plain desc for customModel without extra name', () => {
  const desc = modelNameToDesc('customModel')
  assert.equal(desc, 'Custom Model')
})

test('modelNameToDesc handles custom model with presetPart in Models, customPart not in ModelMode', () => {
  const desc = modelNameToDesc('chatgptFree35-myCustomSuffix')
  assert.equal(desc, 'ChatGPT (Web) (myCustomSuffix)')
})

test('modelNameToDesc handles custom model with presetPart in ModelGroups', () => {
  const desc = modelNameToDesc('bingWebModelKeys-customVariant')
  assert.equal(desc, 'Bing (Web) (customVariant)')
})

test('modelNameToDesc shows Azure OpenAI deployment without duplicate API label', () => {
  const desc = modelNameToDesc('azureOpenAiApiModelKeys-deployment-a')
  assert.equal(desc, 'Azure OpenAI (deployment-a)')
})

test('Azure OpenAI group label remains unchanged', () => {
  assert.equal(ModelGroups.azureOpenAiApiModelKeys.desc, 'Azure OpenAI (API)')
})

test('modelNameToCustomPart returns modelName when not custom', () => {
  assert.equal(modelNameToCustomPart('chatgptFree35'), 'chatgptFree35')
})

test('modelNameToPresetPart returns preset segment for custom names', () => {
  assert.equal(
    modelNameToPresetPart('azureOpenAiApiModelKeys-my-deploy'),
    'azureOpenAiApiModelKeys',
  )
  assert.equal(modelNameToPresetPart('chatgptApi5_3Latest-chatgpt'), 'chatgptApi5_3Latest')
})

test('modelNameToCustomPart keeps entire suffix for multi-hyphen custom names', () => {
  assert.equal(modelNameToCustomPart('azureOpenAiApiModelKeys-my-eu-1'), 'my-eu-1')
  assert.equal(modelNameToCustomPart('chatgptApi5_3Latest-blue-green'), 'blue-green')
})

test('apiModeToModelName uses groupName prefix when itemName is custom', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'custom',
    isCustom: true,
    customName: 'my-endpoint',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  assert.equal(apiModeToModelName(apiMode), 'customApiModelKeys-my-endpoint')
})

test('getApiModesStringArrayFromConfig returns string model names', () => {
  const config = {
    activeApiModes: ['chatgptFree35'],
    customApiModes: [],
    azureDeploymentName: '',
    ollamaModelName: '',
  }
  const result = getApiModesStringArrayFromConfig(config, false)
  assert.ok(Array.isArray(result))
  assert.ok(result.includes('chatgptFree35'))
})

test('isApiModeSelected matches via apiMode JSON comparison', () => {
  const apiMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  const configOrSession = { apiMode: { ...apiMode } }
  assert.equal(isApiModeSelected(apiMode, configOrSession), true)

  const different = { ...apiMode, itemName: 'bingFreeSydney' }
  assert.equal(isApiModeSelected(different, configOrSession), false)
})

test('isApiModeSelected falls back to modelName when apiMode is absent', () => {
  const apiMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  assert.equal(isApiModeSelected(apiMode, { modelName: 'bingFree4' }), true)
  assert.equal(isApiModeSelected(apiMode, { modelName: 'chatgptFree35' }), false)
})

test('isInApiModeGroup matches group via apiMode', () => {
  const apiMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  const bingGroup = ModelGroups.bingWebModelKeys.value
  assert.equal(isInApiModeGroup(bingGroup, { apiMode }), true)
})

test('isInApiModeGroup matches group via modelName', () => {
  const bingGroup = ModelGroups.bingWebModelKeys.value
  assert.equal(isInApiModeGroup(bingGroup, { modelName: 'bingFree4' }), true)
})

test('isInApiModeGroup returns false when group not found', () => {
  assert.equal(isInApiModeGroup(['nonexistent'], { modelName: 'totallyUnknown' }), false)
})

test('modelNameToValue returns value for known model', () => {
  assert.equal(modelNameToValue('chatgptFree35'), 'auto')
})

test('modelNameToValue returns endpoint for latest chatgptApi models', () => {
  assert.equal(modelNameToValue('chatgptApiChatLatest'), 'chat-latest')
  assert.equal(modelNameToValue('chatgptApi5Latest'), 'gpt-5-chat-latest')
  assert.equal(modelNameToValue('chatgptApi5_1Latest'), 'gpt-5.1-chat-latest')
  assert.equal(modelNameToValue('chatgptApi5_2Latest'), 'gpt-5.2-chat-latest')
  assert.equal(modelNameToValue('chatgptApi5_3Latest'), 'gpt-5.3-chat-latest')
})

test('modelNameToValue returns custom part for unknown model', () => {
  assert.equal(modelNameToValue('bingFree4-fast'), 'fast')
})

test('getModelValue uses apiMode when present', () => {
  const apiMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  const value = getModelValue({ apiMode })
  assert.equal(value, '')
})

test('getModelValue uses custom segment for always-custom groups in apiMode', () => {
  const apiMode = {
    groupName: 'azureOpenAiApiModelKeys',
    itemName: 'azureOpenAi',
    isCustom: true,
    customName: 'deployment-east-1',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  const value = getModelValue({ apiMode })
  assert.equal(value, 'deployment-east-1')
})

test('getModelValue uses modelName when apiMode is absent', () => {
  const value = getModelValue({ modelName: 'chatgptFree35' })
  assert.equal(value, 'auto')
})

test('isUsingModelName returns true for exact apiMode match', () => {
  const apiMode = {
    groupName: 'chatgptApiModelKeys',
    itemName: 'chatgptApi35',
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  assert.equal(isUsingModelName('chatgptApi35', { apiMode }), true)
})

test('isUsingModelName resolves ModelGroups presetPart to first value', () => {
  assert.equal(isUsingModelName('bingFree4', { modelName: 'bingWebModelKeys-custom' }), true)
})

test('normalizeApiMode trims providerId', () => {
  const normalized = normalizeApiMode({
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: ' myproxy ',
  })

  assert.equal(normalized.providerId, 'myproxy')
})

test('isApiModeSelected matches apiMode when providerId differs only by whitespace', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: 'myproxy',
  }
  const session = {
    apiMode: {
      ...apiMode,
      providerId: ' myproxy ',
    },
  }

  assert.equal(isApiModeSelected(apiMode, session), true)
})

test('isApiModeSelected returns false when either side apiMode is invalid', () => {
  const validApiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: 'myproxy',
  }

  assert.equal(
    isApiModeSelected(validApiMode, {
      apiMode: 'customApiModelKeys-customModel',
    }),
    false,
  )
  assert.equal(
    isApiModeSelected('customApiModelKeys-customModel', {
      apiMode: validApiMode,
    }),
    false,
  )
  assert.equal(
    isApiModeSelected('customApiModelKeys-customModel', {
      apiMode: 'customApiModelKeys-customModel',
    }),
    false,
  )
})

test('isApiModeSelected returns false when apiMode differs only by active state', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: 'myproxy',
    active: false,
  }
  const session = {
    apiMode: {
      ...apiMode,
      active: true,
    },
  }

  assert.equal(isApiModeSelected(apiMode, session), false)
})

test('isApiModeSelected matches legacy session missing providerId when sessionCompat is enabled', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: 'myproxy',
    active: true,
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'mode-a',
    },
  }

  assert.equal(isApiModeSelected(apiMode, session), false)
  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), true)
})

test('isApiModeSelected ignores active state difference for sessionCompat fallback', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: 'myproxy',
    active: false,
  }
  const session = {
    apiMode: {
      ...apiMode,
      active: true,
    },
  }

  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), true)
})

test('isApiModeSelected keeps provider mismatch fail-closed for non-legacy sessionCompat fallback', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: 'provider-a',
    active: true,
  }
  const session = {
    apiMode: {
      ...apiMode,
      providerId: 'provider-b',
    },
  }

  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), false)
})

test('isApiModeSelected accepts a canonically equivalent session provider ID', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'proxy-model',
    providerId: 'proxy-v1',
    active: true,
  }
  const session = {
    apiMode: {
      ...apiMode,
      providerId: 'Proxy_V1',
    },
  }

  assert.equal(isApiModeSelected(apiMode, session), false)
  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), true)
})

test('getUniquelySelectedApiModeIndex disambiguates provider ID collisions by customUrl', () => {
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      customUrl: 'https://current.example.com/v1/chat/completions',
      providerId: 'legacy-provider',
      active: true,
    },
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      customUrl: 'https://renamed.example.com/v1/chat/completions/',
      providerId: 'renamed-provider',
      legacyProviderIds: ['legacy-provider'],
      active: true,
    },
  ]
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      customUrl: 'https://renamed.example.com/v1/chat/completions',
      providerId: 'legacy-provider',
      active: true,
    },
  }

  assert.equal(getUniquelySelectedApiModeIndex(apiModes, session, { sessionCompat: true }), 1)
  session.apiMode.customUrl = 'https://current.example.com/v1/chat/completions/'
  assert.equal(getUniquelySelectedApiModeIndex(apiModes, session, { sessionCompat: true }), 0)
})

test('isApiModeSelected keeps modern custom session provider mismatch fail-closed with customUrl and apiKey', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'shared-name',
    providerId: 'provider-a',
    active: true,
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'shared-name',
      providerId: 'provider-b',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'modern-session-key',
      active: true,
    },
  }

  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), false)
})

test('isApiModeSelected matches legacy custom session missing itemName and isCustom', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'proxy-model',
    providerId: 'openai-2',
    active: true,
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'stale-session-key',
    },
  }

  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), true)
})

test('isApiModeSelected falls back to modelName when sessionCompat apiMode compare misses', () => {
  const apiMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: false,
    customName: '',
    active: true,
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'different-mode',
      providerId: 'provider-b',
    },
    modelName: 'bingFree4',
  }

  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), false)
})

test('isApiModeSelected falls back to modelName when session apiMode is a non-object string', () => {
  const apiMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: false,
    customName: '',
    active: true,
  }
  const session = {
    apiMode: 'bingFree4',
    modelName: 'bingFree4',
  }

  assert.equal(isApiModeSelected(apiMode, session), false)
  assert.equal(isApiModeSelected(apiMode, session, { sessionCompat: true }), true)
})

test('isApiModeSelected does not double-match via legacy compat and modelName fallback', () => {
  const legacyCustomMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'proxy-model',
    providerId: 'openai-2',
    active: true,
  }
  const bingMode = {
    groupName: 'bingWebModelKeys',
    itemName: 'bingFree4',
    isCustom: false,
    customName: '',
    active: true,
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'stale-session-key',
    },
    modelName: 'bingFree4',
  }

  assert.equal(isApiModeSelected(legacyCustomMode, session, { sessionCompat: true }), true)
  assert.equal(isApiModeSelected(bingMode, session, { sessionCompat: true }), false)
})

test('getUniquelySelectedApiModeIndex returns -1 when legacy session matches multiple custom modes', () => {
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      providerId: 'provider-a',
      active: true,
    },
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      providerId: 'provider-b',
      active: true,
    },
  ]
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'stale-session-key',
    },
  }

  assert.equal(getUniquelySelectedApiModeIndex(apiModes, session, { sessionCompat: true }), -1)
})

test('getUniquelySelectedApiModeIndex returns matching index for a unique legacy session match', () => {
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      providerId: 'provider-a',
      active: true,
    },
    {
      groupName: 'bingWebModelKeys',
      itemName: 'bingFree4',
      isCustom: false,
      customName: '',
      active: true,
    },
  ]
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'stale-session-key',
    },
  }

  assert.equal(getUniquelySelectedApiModeIndex(apiModes, session, { sessionCompat: true }), 0)
})

test('getUniquelySelectedApiModeIndex keeps modern custom session pinned to matching provider', () => {
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'shared-name',
      providerId: 'provider-a',
      active: true,
    },
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'shared-name',
      providerId: 'provider-b',
      active: true,
    },
  ]
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'shared-name',
      providerId: 'provider-b',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'modern-session-key',
      active: true,
    },
  }

  assert.equal(getUniquelySelectedApiModeIndex(apiModes, session, { sessionCompat: true }), 1)
})

test('isApiModeSelected returns true when apiMode active state is equal', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-a',
    providerId: 'myproxy',
    active: true,
  }
  const session = {
    apiMode: {
      ...apiMode,
    },
  }

  assert.equal(isApiModeSelected(apiMode, session), true)
})
