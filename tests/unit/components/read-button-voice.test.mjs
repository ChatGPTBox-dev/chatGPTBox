import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  findMatchingVoice,
  resolveSpeechLanguage,
} from '../../../src/components/ReadButton/voice.mjs'

test('resolveSpeechLanguage uses userLanguage when preference is auto', () => {
  assert.equal(
    resolveSpeechLanguage({ preferredLanguage: 'auto', userLanguage: 'zh-Hant' }),
    'zh-Hant',
  )
})

test('resolveSpeechLanguage preserves an explicit preference', () => {
  assert.equal(resolveSpeechLanguage({ preferredLanguage: 'fr', userLanguage: 'en' }), 'fr')
})

test('findMatchingVoice prefers the matching Chinese script', () => {
  const simplified = { name: 'Simplified', lang: 'zh-CN' }
  const traditional = { name: 'Traditional', lang: 'zh-TW' }

  assert.equal(findMatchingVoice([traditional, simplified], 'zh-Hans'), simplified)
  assert.equal(findMatchingVoice([simplified, traditional], 'zh-Hant'), traditional)
})

test('findMatchingVoice trims surrounding whitespace in language tags', () => {
  const traditional = { name: 'Traditional', lang: '  zh-TW  ' }

  assert.equal(findMatchingVoice([traditional], '  zh-Hant  '), traditional)
})

test('findMatchingVoice prefers the vendor voice within the matching script', () => {
  const genericSimplified = { name: 'Generic Simplified', lang: 'zh-CN' }
  const xiaoyi = { name: 'Microsoft Xiaoyi Online', lang: 'zh-CN' }

  assert.equal(
    findMatchingVoice([genericSimplified, xiaoyi], 'zh-Hans', 'xiaoyi'),
    xiaoyi,
  )
})

test('findMatchingVoice normalizes the preferred vendor name', () => {
  const xiaoyi = { name: 'Microsoft Xiaoyi Online', lang: 'zh-CN' }

  assert.equal(findMatchingVoice([xiaoyi], 'zh-Hans', '  XiaoYi  '), xiaoyi)
})

test('findMatchingVoice does not let a vendor voice override the requested script', () => {
  const xiaoyiSimplified = { name: 'Microsoft Xiaoyi Online', lang: 'zh-CN' }
  const traditional = { name: 'Traditional Chinese', lang: 'zh-TW' }

  assert.equal(
    findMatchingVoice([xiaoyiSimplified, traditional], 'zh-Hant', 'xiaoyi'),
    traditional,
  )
})

test('findMatchingVoice falls back to the base language', () => {
  const genericChinese = { name: 'Generic Chinese', lang: 'zh' }

  assert.equal(findMatchingVoice([genericChinese], 'zh-Hant'), genericChinese)
})

test('findMatchingVoice matches regional variants of the same language', () => {
  const britishEnglish = { name: 'British English', lang: 'en-GB' }

  assert.equal(findMatchingVoice([britishEnglish], 'en-US'), britishEnglish)
})

test('findMatchingVoice returns undefined for invalid or unavailable languages', () => {
  const english = { name: 'English', lang: 'en-US' }

  assert.equal(findMatchingVoice([english], 'not_a_locale'), undefined)
  assert.equal(findMatchingVoice([english], 'ja'), undefined)
})
