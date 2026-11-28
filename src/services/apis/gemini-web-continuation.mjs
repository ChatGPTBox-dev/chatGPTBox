import { protocolError } from '../clients/gemini-web/protocol.mjs'

export const GEMINI_CONTINUATION_STORAGE_PREFIX = 'geminiWebContinuation:'

// Carry the saved revision with safety notifications, not just its request generation.
export function getGeminiContinuationRevision(conversation) {
  const ids = ['c', 'r', 'rc'].map(
    (key, index) => conversation?.[key] || conversation?.metadata?.[index],
  )
  if (typeof ids[0] !== 'string' || !ids[0]) return null
  return JSON.stringify([...ids, conversation?.turnIndex])
}

function continuationIdentity(conversation) {
  const ids = ['c', 'r', 'rc'].map(
    (key, index) => conversation?.[key] || conversation?.metadata?.[index],
  )
  if (
    !ids.every((id) => typeof id === 'string' && id) ||
    !Number.isInteger(conversation?.turnIndex) ||
    conversation.turnIndex < 1
  ) {
    throw protocolError('Invalid conversation state. Start a new conversation.')
  }
  return { id: ids[0], revision: getGeminiContinuationRevision(conversation) }
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function unsafeContinuation() {
  return protocolError(
    'The previous Gemini request may have changed the remote conversation. ' +
      'Start a new ChatGPTBox conversation.',
  )
}

// The background owns this guard. Separate per-conversation keys prevent unrelated
// session-list writes (including other panels and archived cards) from erasing safety state.
// Only hashes of continuation identifiers are stored, never prompts or account credentials.
export function createGeminiContinuationGuard(storage, fingerprint = digest) {
  const active = new Set()
  // Only remember rollbacks proven safe in this background instance. A restart
  // loses that proof and leaves unresolved persisted reservations fail-closed.
  const safeRestores = new Map()
  const restore = async (key, previous) => {
    if (previous === undefined) await storage.remove(key)
    else await storage.set({ [key]: previous })
  }

  return {
    async begin(storedConversation, submittedConversation) {
      const stored = continuationIdentity(storedConversation)
      const submitted = continuationIdentity(submittedConversation)
      if (stored.id !== submitted.id) throw unsafeContinuation()
      const key = GEMINI_CONTINUATION_STORAGE_PREFIX + (await fingerprint(stored.id))
      if (active.has(key)) throw unsafeContinuation()
      active.add(key)

      let previous
      try {
        if (safeRestores.has(key)) {
          await restore(key, safeRestores.get(key))
          safeRestores.delete(key)
        }
        previous = (await storage.get(key))[key]
        const revision = await fingerprint(stored.revision)
        if (previous !== undefined && previous?.revision !== revision) {
          throw unsafeContinuation()
        }
        // Persist before the request can reach the remote conversation. If the
        // background is terminated, an unresolved marker remains fail-closed.
        await storage.set({ [key]: { pending: true } })
      } catch (error) {
        active.delete(key)
        throw error
      }

      let completed = false
      let released = false
      return {
        async complete(conversation) {
          if (released || completed) throw unsafeContinuation()
          const next = continuationIdentity(conversation)
          if (next.id !== stored.id) throw unsafeContinuation()
          const revision = await fingerprint(next.revision)
          await storage.set({ [key]: { revision } })
          completed = true
        },
        async release({ safe }) {
          if (released) return
          released = true
          try {
            if (safe && !completed) {
              safeRestores.set(key, previous)
              await restore(key, previous)
              safeRestores.delete(key)
            }
          } finally {
            active.delete(key)
          }
        },
      }
    },
  }
}
