import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EVIDENCE_LEDGER_LIMITS,
  parseEvidenceLedgerMarkdown,
  splitTranscriptRange,
} from '../../../src/video-summary/evidence-ledger.mjs'

const headings = {
  topics: '主题与人物',
  narrative: '叙事与论证',
  evidence: '事实与证据',
  chapters: '章节候选',
  pending: '待补信息',
  covered: '覆盖位置',
}

function ledgerText({
  topics = '- 主持人 😀：介绍背景',
  narrative = '- [segment:s1] 提出问题\n- [segment:s2] 推导结论',
  evidence = '- [segment:s2] 数据为 42',
  chapters = '- [segment:s1] 开场 — 说明问题',
  pending = '- 后续解释术语',
  covered = 's2',
} = {}) {
  return `## ${headings.topics}\n${topics}\n## ${headings.narrative}\n${narrative}\n## ${headings.evidence}\n${evidence}\n## ${headings.chapters}\n${chapters}\n## ${headings.pending}\n${pending}\n## ${headings.covered}\n${covered}`
}

test('parses all six fixed ledger headings with CJK, emoji, and exact raw text', () => {
  const rawText = ledgerText()
  assert.deepEqual(
    parseEvidenceLedgerMarkdown(rawText, { allowedSegmentIds: new Set(['s1', 's2']) }),
    {
      topics: ['主持人 😀：介绍背景'],
      narrative: [
        { segmentId: 's1', text: '提出问题' },
        { segmentId: 's2', text: '推导结论' },
      ],
      evidence: [{ segmentId: 's2', text: '数据为 42' }],
      chapterCandidates: [{ segmentId: 's1', title: '开场', summary: '说明问题' }],
      pending: ['后续解释术语'],
      coveredThroughSegmentId: 's2',
      rawText,
    },
  )
})

test('validates anchors and covered-through IDs against the allowed set', () => {
  const parsed = parseEvidenceLedgerMarkdown(
    ledgerText({
      narrative: '- [segment:unknown] 未验证\n- [segment:s1] 已验证',
      evidence: '- [segment:unknown] 无效证据',
      chapters: '- [segment:unknown] 无效章节 — 描述',
      covered: 'unknown',
    }),
    { allowedSegmentIds: new Set(['s1']) },
  )
  assert.deepEqual(parsed.narrative, [
    { segmentId: null, text: '未验证' },
    { segmentId: 's1', text: '已验证' },
  ])
  assert.deepEqual(parsed.evidence, [{ segmentId: null, text: '无效证据' }])
  assert.deepEqual(parsed.chapterCandidates, [
    { segmentId: null, title: '无效章节', summary: '描述' },
  ])
  assert.equal(parsed.coveredThroughSegmentId, null)
})

test('consolidates duplicate normalized text and duplicate anchored items', () => {
  const parsed = parseEvidenceLedgerMarkdown(
    ledgerText({
      topics: '- Topic\n- topic',
      narrative:
        '- [segment:s1] First fact\n- [segment:s1] repeated anchor\n- [segment:s2] first   fact',
      evidence: '- [segment:s1] Number 42\n- [segment:s2] number  42',
      chapters: '- [segment:s1] Opening — Intro\n- [segment:s1] Other — Duplicate anchor',
      pending: '- Resolve this\n- resolve   this',
    }),
    { allowedSegmentIds: new Set(['s1', 's2']) },
  )
  assert.deepEqual(parsed.topics, ['Topic'])
  assert.deepEqual(parsed.narrative, [{ segmentId: 's1', text: 'First fact' }])
  assert.deepEqual(parsed.evidence, [{ segmentId: 's1', text: 'Number 42' }])
  assert.deepEqual(parsed.chapterCandidates, [
    { segmentId: 's1', title: 'Opening', summary: 'Intro' },
  ])
  assert.deepEqual(parsed.pending, ['Resolve this'])
})

test('exports and enforces every fixed section item and character limit', () => {
  assert.deepEqual(EVIDENCE_LEDGER_LIMITS, {
    topicCount: 24,
    topicCharacters: 160,
    narrativeCount: 80,
    narrativeCharacters: 240,
    evidenceCount: 120,
    evidenceCharacters: 240,
    chapterCount: 30,
    chapterTitleCharacters: 100,
    chapterDescriptionCharacters: 240,
    pendingCount: 30,
    pendingCharacters: 180,
    totalCharacters: 16_000,
  })
  assert.equal(Object.isFrozen(EVIDENCE_LEDGER_LIMITS), true)
  const items = Array.from(
    { length: 130 },
    (_, index) => `- [segment:s${index}] ${index}-${'😀'.repeat(300)}`,
  )
  const rawText = ledgerText({
    topics: items.slice(0, 25).join('\n'),
    narrative: items.slice(0, 81).join('\n'),
    evidence: items.join('\n'),
    chapters: items
      .slice(0, 31)
      .map((item) => `${item} — ${'乙'.repeat(300)}`)
      .join('\n'),
    pending: items.slice(0, 31).join('\n'),
    covered: 's129',
  })
  assert.throws(
    () => parseEvidenceLedgerMarkdown(rawText, { allowedSegmentIds: new Set(['s129']) }),
    { code: 'MODEL_EVIDENCE_LEDGER_LIMIT_EXCEEDED' },
  )

  const allowedSegmentIds = new Set(Array.from({ length: 130 }, (_, index) => `s${index}`))
  const topics = parseEvidenceLedgerMarkdown(
    ledgerText({
      topics: Array.from({ length: 25 }, (_, index) => `- ${index}-${'甲'.repeat(200)}`).join('\n'),
    }),
    { allowedSegmentIds },
  ).topics
  const narrative = parseEvidenceLedgerMarkdown(
    ledgerText({
      narrative: Array.from({ length: 81 }, (_, index) => `- [segment:s${index}] ${index}`).join(
        '\n',
      ),
    }),
    { allowedSegmentIds },
  ).narrative
  const evidence = parseEvidenceLedgerMarkdown(
    ledgerText({
      evidence: Array.from({ length: 121 }, (_, index) => `- [segment:s${index}] ${index}`).join(
        '\n',
      ),
    }),
    { allowedSegmentIds },
  ).evidence
  const chapterCandidates = parseEvidenceLedgerMarkdown(
    ledgerText({
      chapters: Array.from(
        { length: 31 },
        (_, index) => `- [segment:s${index}] ${index} ${'丁'.repeat(120)} — ${'戊'.repeat(300)}`,
      ).join('\n'),
    }),
    { allowedSegmentIds },
  ).chapterCandidates
  const pending = parseEvidenceLedgerMarkdown(
    ledgerText({
      pending: Array.from({ length: 31 }, (_, index) => `- ${index}-${'己'.repeat(200)}`).join(
        '\n',
      ),
    }),
    { allowedSegmentIds },
  ).pending
  assert.equal(topics.length, 24)
  assert.equal(Array.from(topics[0]).length, 160)
  assert.equal(narrative.length, 80)
  assert.equal(evidence.length, 120)
  assert.equal(chapterCandidates.length, 30)
  assert.equal(Array.from(chapterCandidates[0].title).length, 100)
  assert.equal(Array.from(chapterCandidates[0].summary).length, 240)
  assert.equal(pending.length, 30)
  assert.equal(Array.from(pending[0]).length, 180)
})

test('rejects a complete ledger over the total character limit without whole-ledger truncation', () => {
  const rawText = ledgerText({ topics: `- ${'界'.repeat(EVIDENCE_LEDGER_LIMITS.totalCharacters)}` })
  assert.throws(
    () => parseEvidenceLedgerMarkdown(rawText, { allowedSegmentIds: new Set(['s1', 's2']) }),
    { code: 'MODEL_EVIDENCE_LEDGER_LIMIT_EXCEEDED' },
  )
})

test('splits transcript ranges into deterministic contiguous halves', () => {
  assert.deepEqual(splitTranscriptRange({ startIndex: 0, endIndex: 8 }), [
    { startIndex: 0, endIndex: 4 },
    { startIndex: 4, endIndex: 8 },
  ])
  assert.deepEqual(splitTranscriptRange({ startIndex: 1, endIndex: 6 }), [
    { startIndex: 1, endIndex: 3 },
    { startIndex: 3, endIndex: 6 },
  ])
  assert.deepEqual(splitTranscriptRange({ startIndex: 0, endIndex: 1 }), [])
})
