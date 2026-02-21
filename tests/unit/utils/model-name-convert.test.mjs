import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apiModeToModelName,
  getApiModesFromConfig,
  isUsingModelName,
  modelNameToApiMode,
} from '../../../src/utils/model-name-convert.mjs'

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
