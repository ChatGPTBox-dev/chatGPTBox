import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

const MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17,
  0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44,
  52,
])

function keyFromUrl(value) {
  try {
    const fileName = new URL(String(value || '')).pathname.split('/').pop() || ''
    return fileName.split('.')[0]
  } catch {
    return ''
  }
}

function sanitizeValue(value) {
  return String(value ?? '').replace(/[!'()*]/g, '')
}

export function deriveBilibiliWbiMixinKey(wbiImage) {
  const rawKey = keyFromUrl(wbiImage?.img_url) + keyFromUrl(wbiImage?.sub_url)
  if (rawKey.length < 64) throw new Error('BILIBILI_WBI_KEY_INVALID')
  return MIXIN_KEY_ENC_TAB.map((index) => rawKey[index]).join('').slice(0, 32)
}

export function signBilibiliWbiParams({ params, mixinKey, nowSeconds }) {
  if (!Number.isFinite(nowSeconds)) throw new Error('BILIBILI_WBI_TIMESTAMP_INVALID')
  if (typeof mixinKey !== 'string' || mixinKey.length !== 32) {
    throw new Error('BILIBILI_WBI_KEY_INVALID')
  }

  const values = { ...params, wts: String(Math.floor(nowSeconds)) }
  const query = Object.keys(values)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(sanitizeValue(values[key]))}`)
    .join('&')
  const wRid = bytesToHex(md5(utf8ToBytes(query + mixinKey)))
  return `${query}&w_rid=${wRid}`
}

