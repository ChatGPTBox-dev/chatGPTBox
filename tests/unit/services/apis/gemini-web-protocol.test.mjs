import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildRequest,
  decodeEnvelopes,
  parseAnswer,
} from '../../../../src/services/clients/gemini-web/protocol.mjs'

const metadata = ['c_test', 'r_test', '', null, null, null, null, null, null, 'ctx']

function part(answer, { completion = 2, rc = 'rc_test', meta = metadata } = {}) {
  const candidate = [rc, [answer]]
  if (completion !== null) candidate[8] = [completion]
  return ['wrb.fr', null, JSON.stringify([null, meta, null, null, [candidate]])]
}

function wire(...groups) {
  return (
    ")]}'\n\n" +
    groups
      .map((group) => {
        const payload = JSON.stringify(group)
        return `${payload.length + 2}\n${payload}\n`
      })
      .join('')
  )
}

test('decodes Google frames whose length includes both surrounding line feeds', () => {
  const frame = [part('complete')]
  assert.deepEqual(decodeEnvelopes(wire(frame)), frame)
})

test('frame lengths use JavaScript UTF-16 units', () => {
  const text = '台灣 😀 𠮷'
  assert.equal(parseAnswer(wire([part(text)])).answer, text)
})

test('keeps the latest full answer snapshot across frames', () => {
  const response = wire(
    [part('A', { completion: 1 })],
    [part('AB', { completion: 1 })],
    [part('ABC')],
  )
  assert.equal(parseAnswer(response).answer, 'ABC')
})

test('rejects newer answer text that is not independently confirmed complete', () => {
  const response = wire([part('A')], [part('AB', { completion: null })])
  assert.throws(() => parseAnswer(response), /confirm.*finished generating/)
})

test('processes every RPC record in one frame', () => {
  assert.equal(
    parseAnswer(wire([part('partial', { completion: 1 }), part('final')])).answer,
    'final',
  )
})

test('does not treat ID-looking answer text as protocol metadata', () => {
  assert.equal(parseAnswer(wire([part('c_ is plain text')])).answer, 'c_ is plain text')
})

test('retains continuation metadata with the selected candidate', () => {
  const result = parseAnswer(wire([part('ok')]))
  assert.equal(result.conversationObj.c, 'c_test')
  assert.equal(result.conversationObj.r, 'r_test')
  assert.equal(result.conversationObj.rc, 'rc_test')
  assert.deepEqual(result.conversationObj.metadata.slice(0, 3), ['c_test', 'r_test', 'rc_test'])
})

test('accepts a completed unframed envelope', () => {
  assert.equal(parseAnswer(JSON.stringify([part('legacy')])).answer, 'legacy')
})

test('rejects an unframed answer without a completion marker', () => {
  assert.throws(
    () => parseAnswer(JSON.stringify([part('partial', { completion: null })])),
    /confirm.*finished generating/,
  )
})

test('rejects a framed answer without a completion marker', () => {
  assert.throws(
    () => parseAnswer(wire([part('partial', { completion: null })])),
    /confirm.*finished generating/,
  )
})

test('accepts a status-only final record for the same candidate', () => {
  const final = part('unused')
  const payload = JSON.parse(final[2])
  payload[4][0][1] = null
  final[2] = JSON.stringify(payload)

  assert.equal(
    parseAnswer(wire([part('final text', { completion: 1 }), final])).answer,
    'final text',
  )
})

test('retains pinned conversation identifiers when later frames omit them', () => {
  const result = parseAnswer(
    wire([part('partial', { completion: 1 })], [part('final', { meta: [null, null] })]),
  )
  assert.equal(result.answer, 'final')
  assert.equal(result.conversationObj.c, 'c_test')
  assert.equal(result.conversationObj.r, 'r_test')
})

test('rejects candidate replacement before mixing continuation state', () => {
  const first = part('first', { completion: 1 })
  const second = part('second', { rc: 'rc_other' })
  assert.throws(() => parseAnswer(wire([first, second])), /Candidate changed/)
})

for (const [name, changedMetadata] of [
  ['conversation id', ['c_other', 'r_test']],
  ['response id', ['c_test', 'r_other']],
]) {
  test(`rejects a changed ${name} for the same candidate`, () => {
    const first = part('partial', { completion: 1 })
    const second = part('final', { meta: changedMetadata })
    assert.throws(() => parseAnswer(wire([first, second])), /Conversation identifiers changed/)
  })
}

for (const malformedContent of ['BAD', { 0: 'BAD' }]) {
  test('rejects malformed text candidate containers', () => {
    const record = part('unused')
    const payload = JSON.parse(record[2])
    payload[4][0][1] = malformedContent
    record[2] = JSON.stringify(payload)

    assert.throws(() => parseAnswer(wire([record])), /Invalid text candidate/)
  })
}

test('rejects malformed conversation metadata containers', () => {
  const record = part('unused')
  const payload = JSON.parse(record[2])
  payload[1] = 'BAD'
  record[2] = JSON.stringify(payload)

  assert.throws(() => parseAnswer(wire([record])), /Invalid response payload/)
})

test('rejects malformed candidate containers and entries', () => {
  for (const malformedCandidates of ['BAD', ['BAD']]) {
    const record = part('unused')
    const payload = JSON.parse(record[2])
    payload[4] = malformedCandidates
    record[2] = JSON.stringify(payload)

    assert.throws(() => parseAnswer(wire([record])), /Invalid/)
  }
})

test('rejects malformed completion containers', () => {
  const record = part('unused')
  const payload = JSON.parse(record[2])
  payload[4][0][8] = 'BAD'
  record[2] = JSON.stringify(payload)

  assert.throws(() => parseAnswer(wire([record])), /Invalid response payload/)
})

for (const [name, response] of [
  ['empty response', ''],
  ['HTML response', '<html>Sign in</html>'],
  ['truncated frame', '20\n[]'],
  ['bad JSON frame', '2\n??'],
  ['empty answer', wire([part('')])],
  ['incomplete answer', wire([part('partial', { completion: 1 })])],
  ['missing identifiers', wire([part('ok', { meta: [] })])],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseAnswer(response), { code: 'GEMINI_WEB_PROTOCOL_ERROR' })
  })
}

test('rejects an embedded provider error', () => {
  const error = ['wrb.fr', null, null, null, null, [null, null, [[null, [1037]]]]]
  assert.throws(() => parseAnswer(wire([error])), /1037/)
})

test('builds temporary and extended-thinking request fields without mutating state', () => {
  const conversation = {
    c: 'c_old',
    r: 'r_old',
    rc: 'rc_old',
    metadata: ['c_old', 'r_old', 'rc_old', ['opaque']],
  }
  const before = structuredClone(conversation)
  const outer = JSON.parse(
    buildRequest('Q', conversation, 'zh-TW', 'request-id', {
      temporary: true,
      modelNumber: 3,
      extendedThinking: true,
    }),
  )
  const inner = JSON.parse(outer[1])
  assert.equal(inner.length, 81)
  assert.equal(inner[0][0], 'Q')
  assert.deepEqual(inner[1], ['zh-TW'])
  assert.deepEqual(inner[2], conversation.metadata)
  assert.equal(inner[45], 1)
  assert.equal(inner[59], 'request-id')
  assert.equal(inner[79], 3)
  assert.equal(inner[80], 2)
  assert.deepEqual(conversation, before)
})

test('builds standalone Thinking request fields with no extended-thinking flag', () => {
  const outer = JSON.parse(
    buildRequest('Q', {}, 'zh-TW', 'request-id', {
      modelNumber: 5,
      thinkingMode: null,
    }),
  )
  const inner = JSON.parse(outer[1])
  assert.equal(inner[79], 5)
  assert.equal(inner[80], null)
})
