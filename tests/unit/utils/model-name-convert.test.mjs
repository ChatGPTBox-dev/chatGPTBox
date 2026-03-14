import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apiModeToModelName,
  getApiModesFromConfig,
  getApiModesStringArrayFromConfig,
  isApiModeSelected,
  isInApiModeGroup,
  isUsingModelName,
  modelNameToApiMode,
  modelNameToCustomPart,
  modelNameToDesc,
  modelNameToPresetPart,
  modelNameToValue,
  getModelValue,
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
