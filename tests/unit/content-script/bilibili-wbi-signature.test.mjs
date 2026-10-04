import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveBilibiliWbiMixinKey,
  signBilibiliWbiParams,
} from '../../../src/content-script/site-adapters/bilibili/wbi-signature.mjs'

const wbiImage = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
}

test('derives the 32-character WBI mixin key from nav image URLs', () => {
  assert.equal(deriveBilibiliWbiMixinKey(wbiImage), 'ea1db124af3c7062474693fa704f4ff8')
})

test('signs a canonical WBI parameter set', () => {
  const params = {
    up_mid: '297242063',
    cid: '1335073288',
    bvid: 'BV1L94y1H7CV',
  }
  const query = signBilibiliWbiParams({
    params,
    mixinKey: deriveBilibiliWbiMixinKey(wbiImage),
    nowSeconds: 1_700_000_000,
  })

  assert.equal(
    query,
    'bvid=BV1L94y1H7CV&cid=1335073288&up_mid=297242063&wts=1700000000' +
      '&w_rid=3eceadf7c76409e75bfc87611347e4ac',
  )
})

test('does not mutate caller parameters while signing', () => {
  const params = { bvid: 'BV1L94y1H7CV' }
  const original = structuredClone(params)
  signBilibiliWbiParams({
    params,
    mixinKey: deriveBilibiliWbiMixinKey(wbiImage),
    nowSeconds: 1_700_000_000,
  })
  assert.deepEqual(params, original)
})

test('removes WBI-forbidden characters before URL encoding', () => {
  const query = signBilibiliWbiParams({
    params: { keyword: "a!b(c)*d'e" },
    mixinKey: deriveBilibiliWbiMixinKey(wbiImage),
    nowSeconds: 1_700_000_000,
  })

  assert.match(query, /^keyword=abcde&wts=1700000000&w_rid=[a-f0-9]{32}$/)
})

test('rejects malformed WBI image data', () => {
  assert.throws(() => deriveBilibiliWbiMixinKey({}), {
    message: 'BILIBILI_WBI_KEY_INVALID',
  })
})

test('rejects an invalid WBI timestamp', () => {
  assert.throws(
    () =>
      signBilibiliWbiParams({
        params: {},
        mixinKey: 'valid-but-unused',
        nowSeconds: Number.NaN,
      }),
    { message: 'BILIBILI_WBI_TIMESTAMP_INVALID' },
  )
})

