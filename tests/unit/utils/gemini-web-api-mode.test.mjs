import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig, ModelGroups } from '../../../src/config/index.mjs'
import {
  buildApiModeListConfigUpdate,
  getSelectionPatchWhenApiModeDisabled,
} from '../../../src/popup/api-mode-config-utils.mjs'
import {
  getApiModeDisplayLabel,
  getConversationAiName,
} from '../../../src/popup/sections/api-modes-provider-utils.mjs'
import {
  hasDuplicateGeminiWebPreset,
  resolveGeminiWebPreset,
} from '../../../src/utils/gemini-web-preset.mjs'
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
  assert.equal(resolveGeminiWebPreset(gemini, defaultConfig).model, 'flash')
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
  const structured = preset('Flash', 'flash')

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

test('Gemini Web preset resolver uses Flash when no explicit or compatibility choice exists', () => {
  assert.deepEqual(resolveGeminiWebPreset({}, {}), {
    model: 'flash',
    extendedThinking: false,
    source: 'default',
  })
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

test('Gemini Web preset resolver rejects an explicitly invalid structured model', () => {
  assert.deepEqual(
    resolveGeminiWebPreset(
      {
        customName: 'Flash',
        geminiWebModel: 'garbage-value',
      },
      {
        geminiWebModel: 'flash',
        geminiWebExtendedThinking: true,
      },
    ),
    {
      model: 'garbage-value',
      extendedThinking: false,
      source: 'invalid',
    },
  )
})

test('Gemini Web preset resolver rejects an invalid explicit fallback model', () => {
  assert.deepEqual(
    resolveGeminiWebPreset(
      { customName: 'My Gemini' },
      {
        geminiWebModel: 'garbage-value',
        geminiWebExtendedThinking: true,
      },
    ),
    {
      model: 'garbage-value',
      extendedThinking: false,
      source: 'invalid',
    },
  )
})

test('Gemini Web preset duplicate detection uses semantic model and thinking identity', () => {
  const flash = preset('Flash', 'flash')
  const sameFlash = preset('Different label', 'flash')
  const extended = preset('Flash + Extended thinking', 'flash', true)
  const pro = preset('Pro', 'pro')

  assert.equal(hasDuplicateGeminiWebPreset([flash], sameFlash, -1, defaultConfig), true)
  assert.equal(hasDuplicateGeminiWebPreset([flash], flash, 0, defaultConfig), false)
  assert.equal(hasDuplicateGeminiWebPreset([flash, sameFlash], flash, 0, defaultConfig), true)
  assert.equal(hasDuplicateGeminiWebPreset([flash, pro], pro, 0, defaultConfig), true)
  assert.equal(hasDuplicateGeminiWebPreset([flash], extended, -1, defaultConfig), false)
  assert.equal(hasDuplicateGeminiWebPreset([flash], pro, -1, defaultConfig), false)
  assert.equal(
    hasDuplicateGeminiWebPreset([legacyPreset('Flash')], sameFlash, -1, defaultConfig),
    true,
  )
  assert.equal(getUniquelySelectedApiModeIndex([flash, sameFlash], { apiMode: flash }), 0)
})

test('Gemini Web display label does not mislabel an invalid structured model as Auto', () => {
  assert.equal(
    getApiModeDisplayLabel(
      {
        ...preset('Broken preset', 'flash'),
        geminiWebModel: 'garbage-value',
      },
      zhHant,
    ),
    'Google Gemini (網頁版)',
  )
})

test('legacy Gemini duplicate cleanup preserves the selected row and rebinds its replacement', () => {
  const selected = legacyPreset('Pro')
  const duplicate = legacyPreset('Gemini Pro')
  const other = preset('Flash', 'flash')
  const config = { ...defaultConfig, modelName: 'customModel', apiMode: selected }

  assert.equal(getUniquelySelectedApiModeIndex([duplicate, selected, other], config), 1)
  assert.deepEqual(getSelectionPatchWhenApiModeDisabled(duplicate, [selected, other], config), {})
  assert.deepEqual(
    getSelectionPatchWhenApiModeDisabled(
      duplicate,
      [{ ...duplicate, active: false }, selected],
      config,
    ),
    {},
  )
  assert.deepEqual(getSelectionPatchWhenApiModeDisabled(selected, [duplicate, other], config), {
    apiMode: duplicate,
  })
  assert.deepEqual(
    getSelectionPatchWhenApiModeDisabled(
      selected,
      [{ ...duplicate, active: false }, other],
      config,
    ),
    { modelName: 'customModel', apiMode: null },
  )
})

test('indistinguishable duplicate Gemini rows are not selected arbitrarily', () => {
  const selected = legacyPreset('Pro')
  assert.equal(
    getUniquelySelectedApiModeIndex([selected, { ...selected }], { apiMode: selected }),
    -1,
  )
})

test('Gemini Web labels reflect the effective model for legacy unnamed presets', () => {
  const fallback = { geminiWebModel: 'pro', geminiWebExtendedThinking: true }
  assert.equal(
    getApiModeDisplayLabel(legacyPreset('My mode'), zhHant, [], fallback),
    'Google Gemini (網頁版) (Pro + 延伸思考)',
  )
  assert.equal(
    getApiModeDisplayLabel(legacyPreset('Flash'), zhHant, [], fallback),
    'Google Gemini (網頁版) (Flash)',
  )
})

test('legacy Flash-Lite aliases preserve model identity', () => {
  for (const customName of ['Flash Lite', 'Flash-Lite', 'Flash_Lite']) {
    assert.equal(resolveGeminiWebPreset(legacyPreset(customName)).model, 'flash-lite')
  }
})

test('session selection uses the same fallback Gemini preset as generation', () => {
  const flash = preset('Flash', 'flash')
  const pro = preset('Pro', 'pro')
  const session = { apiMode: legacyPreset('My mode') }
  const config = { ...defaultConfig, geminiWebModel: 'pro' }
  const options = { sessionCompat: true, geminiWebFallbackConfig: config }
  assert.equal(getUniquelySelectedApiModeIndex([flash, pro], session, options), 1)
  assert.equal(getUniquelySelectedApiModeIndex([flash, pro], { apiMode: flash }, options), 0)
})

test('model-name-only Gemini selection matches the effective preset', () => {
  const options = { sessionCompat: true, geminiWebFallbackConfig: { geminiWebModel: 'pro' } }
  const selection = { modelName: 'bardWebFree', apiMode: null }
  assert.equal(
    getUniquelySelectedApiModeIndex(
      [preset('Flash', 'flash'), preset('Pro', 'pro')],
      selection,
      options,
    ),
    1,
  )
})

test('removing a duplicate Gemini preset preserves a model-name-only selection', () => {
  const pro = preset('Pro', 'pro')
  const config = {
    ...defaultConfig,
    modelName: 'bardWebFree',
    apiMode: null,
    geminiWebModel: 'pro',
  }
  assert.deepEqual(getSelectionPatchWhenApiModeDisabled(pro, [legacyPreset('Pro')], config), {})
  assert.deepEqual(getSelectionPatchWhenApiModeDisabled(pro, [], config), {
    modelName: 'customModel',
    apiMode: null,
  })
})

test('legacy model-name-only Gemini conversations display the same preset as request routing', () => {
  const fallback = { geminiWebModel: 'flash', geminiWebExtendedThinking: true }
  const legacy = { modelName: 'bardWebFree-Pro', apiMode: null, aiName: 'Old Gemini label' }
  assert.equal(getConversationAiName(legacy, zhHant, [], fallback), 'Google Gemini (網頁版) (Pro)')
  assert.equal(
    getConversationAiName({ ...legacy, modelName: 'bardWebFree' }, zhHant, [], fallback),
    'Google Gemini (網頁版) (Flash + 延伸思考)',
  )
  assert.equal(
    getConversationAiName(
      { ...legacy, apiMode: preset('Thinking', 'thinking') },
      zhHant,
      [],
      fallback,
    ),
    'Google Gemini (網頁版) (Thinking)',
  )
  const nonGeminiMode = { groupName: 'chatgptApiModelKeys', itemName: 'chatgptApi4oMini' }
  assert.equal(
    getConversationAiName({ ...legacy, apiMode: nonGeminiMode }, zhHant, [], fallback),
    getApiModeDisplayLabel(nonGeminiMode, zhHant, [], fallback),
  )
})
