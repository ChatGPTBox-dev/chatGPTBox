import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig, ModelGroups } from '../../../src/config/index.mjs'
import { buildApiModeListConfigUpdate } from '../../../src/popup/api-mode-config-utils.mjs'
import { getApiModeDisplayLabel } from '../../../src/popup/sections/api-modes-provider-utils.mjs'
import { resolveGeminiWebPreset } from '../../../src/utils/gemini-web-preset.mjs'
import {
  getApiModesFromConfig,
  getUniquelySelectedApiModeIndex,
  isApiModeSelected,
  reconcileMaterializedApiModeDefaults,
} from '../../../src/utils/model-name-convert.mjs'

const [geminiGroupName, geminiGroup] = Object.entries(ModelGroups).find(
  ([, group]) => group.desc === 'Gemini (Web)',
)
const geminiItemName = geminiGroup.value[0]

function preset(customName, model, extendedThinking = false) {
  return {
    groupName: geminiGroupName,
    itemName: geminiItemName,
    isCustom: true,
    customName,
    customUrl: '',
    apiKey: '',
    providerId: '',
    active: true,
    geminiWebModel: model,
    geminiWebExtendedThinking: extendedThinking,
  }
}

function legacyPreset(customName) {
  return {
    groupName: geminiGroupName,
    itemName: geminiItemName,
    isCustom: true,
    customName,
    customUrl: '',
    apiKey: '',
    providerId: '',
    active: true,
  }
}

function zhHant(key) {
  if (key === 'Gemini (Web)') return 'Gemini (網頁版)'
  if (key === 'Extended thinking') return '延伸思考'
  return key
}

test('Gemini Web is available as a default API mode without manual enablement', () => {
  const modes = getApiModesFromConfig(
    {
      ...defaultConfig,
      activeApiModes: [...defaultConfig.activeApiModes],
      customApiModes: [],
      knownApiModeDefaultIds: [],
    },
    true,
  )
  const gemini = modes.find((mode) => mode.groupName === geminiGroupName)

  assert.ok(gemini)
  assert.equal(gemini.itemName, geminiItemName)
  assert.equal(gemini.active, true)
})

test('an explicit API-mode snapshot does not get Gemini Web backfilled', () => {
  const modes = getApiModesFromConfig(
    {
      configSchemaVersion: 2,
      activeApiModes: ['claude2WebFree'],
      customApiModes: [],
      geminiWebModel: 'auto',
      knownApiModeDefaultIds: [],
    },
    true,
  )

  assert.equal(
    modes.some((mode) => mode.groupName === geminiGroupName),
    false,
  )
})

test('migration-style empty API-mode probing does not synthesize Gemini Web', () => {
  const modes = getApiModesFromConfig(
    {
      activeApiModes: [],
      customApiModes: [],
      geminiWebModel: 'auto',
      knownApiModeDefaultIds: [],
    },
    false,
  )

  assert.equal(
    modes.some((mode) => mode.groupName === geminiGroupName),
    false,
  )
})

test('configured Gemini presets suppress a legacy base active entry', () => {
  const disabled = { ...preset('Pro', 'pro'), active: false }
  const config = {
    activeApiModes: [geminiItemName],
    customApiModes: [disabled],
    geminiWebModel: 'auto',
    knownApiModeDefaultIds: [],
  }
  const allModes = getApiModesFromConfig(config, false)
  const activeModes = getApiModesFromConfig(config, true)
  const allGeminiModes = allModes.filter((mode) => mode.groupName === geminiGroupName)

  assert.equal(allGeminiModes.length, 1)
  assert.equal(allGeminiModes[0].customName, 'Pro')
  assert.equal(allGeminiModes[0].active, false)
  assert.equal(
    activeModes.some((mode) => mode.groupName === geminiGroupName),
    false,
  )
})

test('an explicitly disabled Gemini Web row stays disabled', () => {
  const disabled = { ...preset('Auto', 'auto'), active: false }
  const modes = getApiModesFromConfig(
    {
      activeApiModes: [],
      customApiModes: [disabled],
      geminiWebModel: 'auto',
    },
    true,
  )

  assert.equal(
    modes.some((mode) => mode.groupName === geminiGroupName),
    false,
  )
})

test('a handled Gemini Web default stays absent after its row is removed', () => {
  const modes = getApiModesFromConfig(
    {
      activeApiModes: [],
      customApiModes: [],
      geminiWebModel: 'auto',
      knownApiModeDefaultIds: [geminiItemName],
    },
    true,
  )

  assert.equal(
    modes.some((mode) => mode.groupName === geminiGroupName),
    false,
  )
})

test('saving the API mode list marks the Gemini Web default as handled', () => {
  const update = buildApiModeListConfigUpdate(
    {
      knownApiModeDefaultIds: [],
      geminiWebModel: 'auto',
    },
    [],
  )

  assert.equal(update.knownApiModeDefaultIds.includes(geminiItemName), true)
})

test('default reconciliation is not confused by the implicit Gemini Web default', () => {
  const result = reconcileMaterializedApiModeDefaults(
    {
      activeApiModes: [],
      customApiModes: [],
      geminiWebModel: 'auto',
    },
    ['claude2WebFree'],
    [],
  )

  assert.equal(
    result.customApiModes.some((mode) => mode.itemName === 'claude2WebFree'),
    true,
  )
  assert.deepEqual(result.knownApiModeDefaultIds, ['claude2WebFree'])
})

test('Gemini Web API mode presets can keep multiple model combinations', () => {
  const flash = preset('Flash', 'flash')
  const extended = preset('Flash + Extended thinking', 'flash', true)
  const thinking = preset('Thinking', 'thinking')
  const pro = preset('Pro', 'pro')
  const config = {
    activeApiModes: [],
    customApiModes: [flash, extended, thinking, pro],
  }

  const modes = getApiModesFromConfig(config, true)
  assert.deepEqual(
    modes.map((mode) => mode.customName),
    ['Flash', 'Flash + Extended thinking', 'Thinking', 'Pro'],
  )
})

test('Gemini Web API mode selection distinguishes thinking from the same base model', () => {
  const flash = preset('Flash', 'flash')
  const extended = preset('Flash + Extended thinking', 'flash', true)

  assert.equal(isApiModeSelected(flash, { apiMode: extended }), false)
  assert.equal(isApiModeSelected(extended, { apiMode: extended }), true)
  assert.equal(getUniquelySelectedApiModeIndex([flash, extended], { apiMode: extended }), 1)
})

test('Gemini Web API mode selection uses structured preset identity when labels collide', () => {
  const flash = preset('Same Gemini label', 'flash')
  const extended = preset('Same Gemini label', 'flash', true)
  const pro = preset('Same Gemini label', 'pro')
  const selection = { apiMode: extended }

  assert.equal(isApiModeSelected(flash, selection), false)
  assert.equal(isApiModeSelected(extended, selection), true)
  assert.equal(isApiModeSelected(pro, selection), false)
  assert.equal(getUniquelySelectedApiModeIndex([flash, extended, pro], selection), 1)
  assert.equal(
    getUniquelySelectedApiModeIndex([flash, extended, pro], selection, {
      sessionCompat: true,
    }),
    1,
  )
})

test('Gemini Web preset identity ignores materialization metadata', () => {
  const materialized = {
    groupName: geminiGroupName,
    itemName: geminiItemName,
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    providerId: '',
    active: true,
  }
  const structured = preset('Auto', 'auto')

  assert.equal(isApiModeSelected(materialized, { apiMode: structured }), true)
  assert.equal(isApiModeSelected(structured, { apiMode: materialized }), true)
  assert.equal(
    isApiModeSelected(structured, { apiMode: materialized }, { sessionCompat: true }),
    true,
  )
})

test('Gemini Web preset identity keeps provider mismatches fail-closed', () => {
  const first = { ...preset('Auto', 'auto'), providerId: 'provider-a' }
  const second = { ...preset('Different label', 'auto'), providerId: 'provider-b' }

  assert.equal(isApiModeSelected(first, { apiMode: second }), false)
  assert.equal(isApiModeSelected(first, { apiMode: second }, { sessionCompat: true }), false)
})

test('Gemini Web API mode selection keeps legacy preset names compatible', () => {
  const legacy = legacyPreset('Flash + Extended thinking')
  const structured = preset('Flash + Extended thinking', 'flash', true)

  assert.equal(isApiModeSelected(structured, { apiMode: legacy }), true)
  assert.equal(isApiModeSelected(legacy, { apiMode: structured }), true)
})

test('Gemini Web API mode custom fields survive normalization', () => {
  const thinking = preset('Thinking', 'thinking')
  const [normalized] = getApiModesFromConfig(
    { activeApiModes: [], customApiModes: [thinking] },
    true,
  )

  assert.equal(normalized.geminiWebModel, 'thinking')
  assert.equal(normalized.geminiWebExtendedThinking, false)
})

test('Gemini Web display label uses the localized web product name and thinking text', () => {
  assert.equal(
    getApiModeDisplayLabel(preset('Flash + Extended thinking', 'flash', true), zhHant),
    'Google Gemini (網頁版) (Flash + 延伸思考)',
  )
  assert.equal(
    getApiModeDisplayLabel(preset('Thinking', 'thinking'), zhHant),
    'Google Gemini (網頁版) (Thinking)',
  )
})

test('Gemini Web display labels preserve legacy preset model names', () => {
  assert.equal(
    getApiModeDisplayLabel(legacyPreset('Flash'), zhHant),
    'Google Gemini (網頁版) (Flash)',
  )
  assert.equal(
    getApiModeDisplayLabel(legacyPreset('Flash + Extended thinking'), zhHant),
    'Google Gemini (網頁版) (Flash + 延伸思考)',
  )
  assert.equal(getApiModeDisplayLabel(legacyPreset('Pro'), zhHant), 'Google Gemini (網頁版) (Pro)')
  assert.equal(
    getApiModeDisplayLabel(legacyPreset('Pro + Extended thinking'), zhHant),
    'Google Gemini (網頁版) (Pro + 延伸思考)',
  )
  assert.equal(
    getApiModeDisplayLabel(legacyPreset('Thinking'), zhHant),
    'Google Gemini (網頁版) (Thinking)',
  )
})

test('Gemini Web preset resolver preserves explicit disabled thinking over global fallback', () => {
  assert.deepEqual(
    resolveGeminiWebPreset(
      {
        customName: 'My Gemini',
        geminiWebExtendedThinking: false,
      },
      {
        geminiWebModel: 'flash',
        geminiWebExtendedThinking: true,
      },
    ),
    {
      model: 'flash',
      extendedThinking: false,
      source: 'fallback',
    },
  )
})
