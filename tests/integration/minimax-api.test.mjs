import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  miniMaxApiModelKeys,
  isUsingMiniMaxApiModel,
  Models,
  ModelGroups,
} from '../../src/config/index.mjs'

describe('MiniMax integration', () => {
  test('all MiniMax model keys have corresponding Models entries', () => {
    for (const key of miniMaxApiModelKeys) {
      assert.ok(Models[key], `Models entry missing for ${key}`)
      assert.ok(Models[key].value, `Models[${key}].value is empty`)
      assert.ok(Models[key].desc, `Models[${key}].desc is empty`)
    }
  })

  test('MiniMax model group is registered in ModelGroups', () => {
    assert.ok(ModelGroups.miniMaxApiModelKeys, 'MiniMax group missing from ModelGroups')
    assert.equal(ModelGroups.miniMaxApiModelKeys.desc, 'MiniMax (API)')
    assert.deepEqual(ModelGroups.miniMaxApiModelKeys.value, miniMaxApiModelKeys)
  })

  test('MiniMax model values match expected API model names', () => {
    assert.equal(Models.minimax_m27.value, 'MiniMax-M2.7')
    assert.equal(Models.minimax_m25.value, 'MiniMax-M2.5')
    assert.equal(Models.minimax_m25_highspeed.value, 'MiniMax-M2.5-highspeed')
  })

  test('isUsingMiniMaxApiModel does not match other provider models', () => {
    const otherModels = [
      'chatgptApi4oMini',
      'deepseek_chat',
      'moonshot_v1_8k',
      'claude37SonnetApi',
      'customModel',
      'ollamaModel',
    ]
    for (const modelName of otherModels) {
      assert.equal(isUsingMiniMaxApiModel({ modelName }), false, `Should not match ${modelName}`)
    }
  })

  test('MiniMax model keys are unique and do not overlap with other groups', () => {
    const allOtherKeys = []
    for (const [groupName, group] of Object.entries(ModelGroups)) {
      if (groupName === 'miniMaxApiModelKeys') continue
      allOtherKeys.push(...group.value)
    }
    for (const key of miniMaxApiModelKeys) {
      assert.equal(
        allOtherKeys.includes(key),
        false,
        `MiniMax key ${key} overlaps with another group`,
      )
    }
  })
})
