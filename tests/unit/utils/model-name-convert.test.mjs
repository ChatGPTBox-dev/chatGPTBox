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

test('modelNameToCustomPart returns modelName when not custom', () => {
  assert.equal(modelNameToCustomPart('chatgptFree35'), 'chatgptFree35')
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
