import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import Browser from 'webextension-polyfill'
import {
  createSession,
  deleteSession,
  getSession,
  getSessions,
  handleLocalSessionMessage,
  resetSessions,
  runLocalSessionOperation,
  reconcileStoredProviderMode,
  updateSession,
} from '../../../src/services/local-session.mjs'
import { initSession } from '../../../src/services/init-session.mjs'
import { getSessionContentRevision } from '../../../src/components/ConversationCard/session.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('createSession without argument creates a new default session', async () => {
  const { session, currentSessions } = await createSession()

  assert.match(session.sessionId, UUID_RE)
  // getSessions auto-initializes a reset session when storage is empty,
  // so the result contains the new session plus the reset default
  assert.ok(currentSessions.length >= 1)
  assert.equal(currentSessions[0].sessionId, session.sessionId)
})

test('createSession with a session object inserts it', async () => {
  const custom = initSession({ sessionName: 'Custom Chat' })
  const { session, currentSessions } = await createSession(custom)

  assert.equal(session.sessionName, 'Custom Chat')
  assert.ok(currentSessions.length >= 1)
  assert.equal(currentSessions[0].sessionId, custom.sessionId)
})

test('createSession upserts existing session by sessionId', async () => {
  // Pre-seed storage so getSession finds the original
  const original = initSession({ sessionName: 'Original' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })

  const updated = { ...original, sessionName: 'Updated' }
  const { session, currentSessions } = await createSession(updated)

  assert.equal(session.sessionName, 'Updated')
  assert.equal(currentSessions.length, 1)
  assert.equal(currentSessions[0].sessionName, 'Updated')
})

test('deleteSession removes a session by id', async () => {
  const s1 = initSession({ sessionName: 'First' })
  const s2 = initSession({ sessionName: 'Second' })
  // Pre-seed storage directly to avoid auto-initialization side effects
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [s1, s2] })

  const remaining = await deleteSession(s1.sessionId)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].sessionId, s2.sessionId)
})

test('deleteSession resets when last session is removed', async () => {
  const s = initSession({ sessionName: 'Only' })
  // Directly seed storage with exactly one session to avoid auto-init side-effect
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [s] })

  const result = await deleteSession(s.sessionId)
  // should trigger resetSessions() fallback and return a fresh default session
  assert.equal(result.length, 1)
  assert.notEqual(result[0].sessionId, s.sessionId)
})

test('resetSessions replaces all sessions with one default', async () => {
  const s1 = initSession({ sessionName: 'A' })
  const s2 = initSession({ sessionName: 'B' })
  await createSession(s1)
  await createSession(s2)

  const result = await resetSessions()
  assert.equal(result.length, 1)
  assert.match(result[0].sessionId, UUID_RE)
})

test('getSessions initializes when storage is empty', async () => {
  const sessions = await getSessions()

  assert.equal(sessions.length, 1)
  assert.match(sessions[0].sessionId, UUID_RE)
})

test('getSessions returns existing sessions from storage', async () => {
  const s = initSession({ sessionName: 'Persisted' })
  await createSession(s)

  const sessions = await getSessions()
  assert.ok(sessions.some((sess) => sess.sessionId === s.sessionId))
})

test('getSessions migrates legacy model keys without changing conversation records', async () => {
  const legacy = initSession({
    sessionName: 'Legacy',
    modelName: 'claude2Api',
    apiMode: {
      groupName: 'claudeApiModelKeys',
      itemName: 'claude2Api',
      isCustom: false,
      customName: '',
      customUrl: '',
      apiKey: '',
      providerId: '',
      active: true,
    },
  })
  legacy.conversationRecords = [{ role: 'assistant', answer: 'old answer' }]
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [legacy] })

  const sessions = await getSessions()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(sessions[0].sessionId, legacy.sessionId)
  assert.equal(sessions[0].modelName, 'claudeSonnet46Api')
  assert.equal(sessions[0].apiMode.itemName, 'claudeSonnet46Api')
  assert.deepEqual(sessions[0].conversationRecords, [{ role: 'assistant', answer: 'old answer' }])
  assert.equal(storage.sessions[0].modelName, 'claudeSonnet46Api')
  assert.equal(storage.sessions[0].apiMode.itemName, 'claudeSonnet46Api')
})

test('getSession finds session by id', async () => {
  const s = initSession({ sessionName: 'Find Me' })
  await createSession(s)

  const { session } = await getSession(s.sessionId)
  assert.equal(session.sessionId, s.sessionId)
  assert.equal(session.sessionName, 'Find Me')
})

test('getSession returns undefined for non-existent id', async () => {
  await createSession()
  const { session } = await getSession('non-existent-id')
  assert.equal(session, undefined)
})

test('updateSession sets updatedAt and persists changes', async () => {
  const s = initSession({ sessionName: 'Before' })
  await createSession(s)

  const modified = { ...s, sessionName: 'After' }
  const result = await updateSession(modified)

  const found = result.find((sess) => sess.sessionId === s.sessionId)
  assert.equal(found.sessionName, 'After')
  assert.ok(found.updatedAt >= s.updatedAt)
})

test('storage persistence: data survives across calls', async () => {
  const s = initSession({ sessionName: 'Persistent' })
  await createSession(s)

  // Retrieve via a separate getSessions call
  const sessions = await getSessions()
  const found = sessions.find((sess) => sess.sessionId === s.sessionId)
  assert.equal(found.sessionName, 'Persistent')

  // Verify raw storage
  const raw = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  assert.ok(Array.isArray(raw.sessions))
  assert.ok(raw.sessions.some((sess) => sess.sessionId === s.sessionId))
})

test('background session operations serialize concurrent creation, update, and deletion', async () => {
  const first = initSession({ sessionName: 'First' })
  const second = initSession({ sessionName: 'Second' })
  const third = initSession({ sessionName: 'Third' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [first, second] })
  await Promise.all([
    runLocalSessionOperation('createSession', [third]),
    runLocalSessionOperation('updateSession', [{ ...second, sessionName: 'Updated' }]),
    runLocalSessionOperation('deleteSession', [first.sessionId]),
  ])
  const sessions = await runLocalSessionOperation('getSessions')
  assert.deepEqual(
    sessions.map((session) => session.sessionName),
    ['Third', 'Updated'],
  )
})

test('an update or delete for a removed session cannot remove or resurrect another session', async () => {
  const first = initSession({ sessionName: 'First' })
  const second = initSession({ sessionName: 'Second' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [first, second] })
  await Promise.all([
    runLocalSessionOperation('deleteSession', [first.sessionId]),
    runLocalSessionOperation('updateSession', [first]),
    runLocalSessionOperation('deleteSession', [first.sessionId]),
  ])
  assert.deepEqual(await runLocalSessionOperation('getSessions'), [second])
})

test('provider override migration and rollback preserve queued conversation writes', async () => {
  const identity = {
    groupName: 'customApiModelKeys',
    itemName: 'gpt-4',
    customName: 'Mode',
    isCustom: true,
  }
  const migration = {
    identity,
    fromProviderId: 'source-provider',
    toProviderId: 'mode-override-provider',
  }
  const original = {
    ...initSession({ sessionName: 'Original' }),
    apiMode: { ...identity, providerId: migration.fromProviderId, apiKey: 'old-key' },
  }
  const extra = initSession({ sessionName: 'Extra' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })
  const records = [{ question: 'New question', answer: 'New answer' }]

  const [, migrated] = await Promise.all([
    runLocalSessionOperation('updateSession', [{ ...original, conversationRecords: records }]),
    runLocalSessionOperation('migrateProviderOverrideSessions', [migration]),
    runLocalSessionOperation('createSession', [extra]),
  ])
  assert.equal(migrated.changed, true)
  const migratedSession = migrated.migratedSessions[0]
  assert.equal(migratedSession.apiMode.providerId, migration.toProviderId)
  assert.deepEqual(migratedSession.conversationRecords, records)

  const laterRecords = [...records, { question: 'Follow-up', answer: 'Next answer' }]
  await Promise.all([
    runLocalSessionOperation('updateSession', [
      { ...migratedSession, conversationRecords: laterRecords },
    ]),
    runLocalSessionOperation('rollbackProviderOverrideSessions', [migrated.sessions, migration]),
  ])

  const sessions = await runLocalSessionOperation('getSessions')
  assert.equal(sessions.length, 2)
  const restored = sessions.find((session) => session.sessionId === original.sessionId)
  assert.equal(restored.apiMode.providerId, migration.fromProviderId)
  assert.equal(restored.apiMode.apiKey, 'old-key')
  assert.deepEqual(restored.conversationRecords, laterRecords)
  assert.ok(sessions.some((session) => session.sessionId === extra.sessionId))
})

test('a mounted panel save cannot revert a provider override migration', async () => {
  const mode = {
    groupName: 'customApiModelKeys',
    itemName: 'gpt-4',
    customName: 'Mode',
    isCustom: true,
    providerId: 'source',
  }
  const original = { ...initSession({ sessionName: 'Original' }), apiMode: mode }
  const migratedMode = { ...mode, providerId: 'override', apiKey: '' }
  const migrated = { ...original, apiMode: migratedMode }
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [migrated] })
  const records = [{ question: 'New question', answer: 'New answer' }]
  const [saved] = await runLocalSessionOperation('updateSession', [
    { ...original, conversationRecords: records },
    mode,
  ])
  assert.deepEqual(saved.apiMode, migratedMode)
  assert.deepEqual(saved.conversationRecords, records)

  const explicitSelection = { ...mode, providerId: 'other' }
  const [changed] = await runLocalSessionOperation('updateSession', [
    { ...original, conversationRecords: records, apiMode: explicitSelection },
    mode,
  ])
  assert.deepEqual(changed.apiMode, explicitSelection)
})

test('stale Gemini safety notices do not restore a cleared transcript', async () => {
  const original = {
    ...initSession({ sessionName: 'Original' }),
    question: 'Q',
    conversationRecords: [{ question: 'Q', answer: 'A' }],
    geminiWeb_conversation: { c: 'c', r: 'r', rc: 'rc', turnIndex: 1 },
  }
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })
  const cleared = {
    ...original,
    question: null,
    conversationRecords: [],
    geminiWeb_conversation: null,
  }
  await runLocalSessionOperation('updateSession', [
    cleared,
    null,
    getSessionContentRevision(original),
    'clear',
  ])
  const [saved] = await runLocalSessionOperation('updateSession', [
    { ...original, geminiWeb_conversationUnsafe: true },
    null,
    getSessionContentRevision(original),
    'unsafe',
  ])
  assert.deepEqual(saved.conversationRecords, [])
  assert.equal(saved.geminiWeb_conversation, null)
  assert.notEqual(saved.geminiWeb_conversationUnsafe, true)
  const [lateCompletion] = await runLocalSessionOperation('updateSession', [
    {
      ...original,
      conversationRecords: [...original.conversationRecords, { question: 'Q2', answer: 'A2' }],
    },
    null,
    getSessionContentRevision(original),
  ])
  assert.deepEqual(lateCompletion.conversationRecords, [])
})

test('clearing from a stale panel cannot delete a newer transcript', async () => {
  const original = {
    ...initSession(),
    question: 'Q',
    conversationRecords: [{ question: 'Q', answer: 'A' }],
    geminiWeb_conversation: { c: 'c', r: 'r', rc: 'rc', turnIndex: 1 },
  }
  const latest = {
    ...original,
    conversationRecords: [
      ...original.conversationRecords,
      { question: 'Other', answer: 'New answer' },
    ],
    geminiWeb_conversation: { c: 'c', r: 'r2', rc: 'rc2', turnIndex: 2 },
    geminiWeb_conversationUnsafe: true,
  }
  const cleared = { ...initSession(), sessionId: original.sessionId }
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [latest] })

  for (const revision of [getSessionContentRevision(original), null, undefined]) {
    const [saved] = await runLocalSessionOperation('updateSession', [
      cleared,
      null,
      revision,
      'clear',
    ])
    assert.deepEqual(saved, latest)
    assert.deepEqual(await runLocalSessionOperation('getSessions'), [latest])
  }

  const [saved] = await runLocalSessionOperation('updateSession', [
    cleared,
    null,
    getSessionContentRevision(latest),
    'clear',
  ])
  assert.deepEqual(saved.conversationRecords, [])
  assert.equal(saved.geminiWeb_conversation, null)
  assert.notEqual(saved.geminiWeb_conversationUnsafe, true)
})

test('safety-only persistence updates the matching revision without replacing the transcript', async () => {
  const original = {
    ...initSession({ sessionName: 'Original' }),
    question: 'Q',
    conversationRecords: [{ question: 'Q', answer: 'A' }],
    geminiWeb_conversation: { c: 'c', r: 'r', rc: 'rc', turnIndex: 1 },
  }
  const latest = {
    ...original,
    conversationRecords: [
      ...original.conversationRecords,
      { question: 'Other', answer: 'Other answer' },
    ],
  }
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [latest] })
  const [saved] = await runLocalSessionOperation('updateSession', [
    { ...original, geminiWeb_conversationUnsafe: true },
    null,
    getSessionContentRevision(original),
    'unsafe',
  ])
  assert.deepEqual(saved.conversationRecords, latest.conversationRecords)
  assert.equal(saved.geminiWeb_conversationUnsafe, true)
})

test('a missing rolled-back override cannot replace a configured provider binding', () => {
  const mode = {
    groupName: 'customApiModelKeys',
    itemName: 'gpt-4',
    customName: 'Mode',
    isCustom: true,
    providerId: 'xai',
  }
  const stale = { ...mode, providerId: 'removed-override' }
  assert.deepEqual(reconcileStoredProviderMode(stale, mode, mode, {}), mode)
})

test('full save preserves unsafe state without an incoming remote ID', async () => {
  const original = {
    ...initSession(),
    geminiWeb_conversationUnsafe: true,
    geminiWeb_conversation: { c: 'c', r: 'r', rc: 'rc', turnIndex: 1 },
  }
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })
  const next = { ...original, geminiWeb_conversation: null }
  delete next.geminiWeb_conversationUnsafe
  const [saved] = await runLocalSessionOperation('updateSession', [
    next,
    null,
    getSessionContentRevision(original),
  ])
  assert.equal(saved.geminiWeb_conversationUnsafe, true)
})

test('a guarded full write without a trusted baseline preserves the stored transcript', async () => {
  const original = {
    ...initSession(),
    question: 'Original',
    conversationRecords: [{ question: 'Original', answer: 'Saved' }],
  }
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })
  const stale = {
    ...original,
    question: 'Stale',
    conversationRecords: [{ question: 'Stale', answer: 'Unsaved' }],
  }
  const [saved] = await runLocalSessionOperation('updateSession', [stale, null, null, 'full'])
  assert.deepEqual(saved, original)
})

test('a disabled explicitly selected provider is never replaced by another binding', () => {
  const mode = {
    groupName: 'customApiModelKeys',
    itemName: 'gpt-4',
    customName: 'Mode',
    isCustom: true,
    providerId: 'xai',
  }
  const requested = { ...mode, providerId: 'disabled-provider' }
  const config = {
    customOpenAIProviders: [
      {
        id: 'disabled-provider',
        name: 'Disabled',
        enabled: false,
        chatCompletionsUrl: 'https://example.com/v1/chat/completions',
      },
    ],
  }
  assert.deepEqual(reconcileStoredProviderMode(requested, mode, mode, config), requested)
})

test('local session messaging denies untrusted senders and restricts content scripts to archiving', async () => {
  const original = initSession({ sessionName: 'Private conversation' })
  const archive = initSession({ sessionName: 'New archive' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })
  const extensionPage = {
    id: Browser.runtime.id,
    url: Browser.runtime.getURL('IndependentPanel.html'),
  }
  const contentScript = { id: Browser.runtime.id, url: 'https://example.com/' }
  const foreignExtension = { id: 'another-extension', url: extensionPage.url }
  const externalPage = { url: contentScript.url }
  const lookalike = {
    id: Browser.runtime.id,
    url: Browser.runtime.getURL('').replace(/\/$/, '-other/'),
  }

  for (const sender of [foreignExtension, externalPage, {}, undefined]) {
    assert.deepEqual(
      await handleLocalSessionMessage({ operation: 'archiveSession', args: [archive] }, sender),
      { ok: false },
    )
  }
  for (const sender of [contentScript, lookalike, { id: Browser.runtime.id }]) {
    for (const [operation, args] of [
      ['getSessions', []],
      ['getSession', [original.sessionId]],
      ['createSession', [original]],
      ['updateSession', [{ ...original, sessionName: 'Changed' }]],
      ['deleteSession', [original.sessionId]],
      ['resetSessions', []],
      ['importLocalData', [{ sessions: [] }]],
      ['migrateProviderOverrideSessions', [{}]],
      ['rollbackProviderOverrideSessions', [[], {}]],
    ]) {
      assert.deepEqual(await handleLocalSessionMessage({ operation, args }, sender), { ok: false })
    }
  }
  assert.deepEqual(globalThis.__TEST_BROWSER_SHIM__.getStorage().sessions, [original])
  for (const sender of [extensionPage, { origin: Browser.runtime.getURL('').replace(/\/$/, '') }]) {
    const result = await handleLocalSessionMessage({ operation: 'getSessions', args: [] }, sender)
    assert.deepEqual(result, { ok: true, value: [original] })
  }
  assert.deepEqual(
    await handleLocalSessionMessage(
      { operation: 'archiveSession', args: [archive] },
      contentScript,
    ),
    { ok: true, value: null },
  )
  assert.deepEqual(globalThis.__TEST_BROWSER_SHIM__.getStorage().sessions, [archive, original])
})

test('retrying an archive is write-only and cannot overwrite an existing session', async (t) => {
  const original = initSession({ sessionName: 'Original archive' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })
  const contentScript = { id: Browser.runtime.id, url: 'https://example.com/' }
  t.mock.method(console, 'error', () => {})
  for (const session of [
    { ...original, sessionId: [original.sessionId] },
    { ...original, conversationRecords: null },
  ]) {
    assert.deepEqual(
      await handleLocalSessionMessage(
        { operation: 'archiveSession', args: [session] },
        contentScript,
      ),
      { ok: false },
    )
  }
  for (const session of [original, { ...original, sessionName: 'Stale archive retry' }]) {
    assert.deepEqual(
      await handleLocalSessionMessage(
        { operation: 'archiveSession', args: [session] },
        contentScript,
      ),
      { ok: true, value: null },
    )
  }
  assert.deepEqual(globalThis.__TEST_BROWSER_SHIM__.getStorage().sessions, [original])
})

test('backup imports serialize with session writes and preserve imported unsafe continuations', async () => {
  const session = {
    ...initSession({ sessionName: 'Before import' }),
    conversationRecords: [{ question: 'Q', answer: 'A' }],
    geminiWeb_conversation: { c: 'c-test', r: 'r-test', rc: 'rc-test' },
  }
  const revision = getSessionContentRevision(session)
  const imported = { ...session, sessionName: 'Imported' }
  const stale = {
    ...session,
    conversationRecords: [...session.conversationRecords, { question: 'Q2', answer: 'A2' }],
  }
  for (const importFirst of [false, true]) {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })
    const operations = [
      () => runLocalSessionOperation('importLocalData', [{ sessions: [imported] }]),
      () => runLocalSessionOperation('updateSession', [stale, null, revision]),
    ]
    if (!importFirst) operations.reverse()
    await Promise.all(operations.map((operation) => operation()))
    const saved = globalThis.__TEST_BROWSER_SHIM__.getStorage().sessions
    assert.equal(saved.length, 1)
    assert.equal(saved[0].geminiWeb_conversationUnsafe, true)
    assert.equal(saved[0].sessionId, session.sessionId)
    assert.deepEqual(
      saved[0].conversationRecords,
      importFirst ? stale.conversationRecords : imported.conversationRecords,
    )
  }
})
