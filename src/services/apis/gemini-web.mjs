import { resolveGeminiWebPreset } from '../../utils/gemini-web-preset.mjs'
import { GEMINI_WEB_MODEL_NUMBERS } from './gemini-web-transport.mjs'
import { pushRecord, setAbortController } from './shared.mjs'
import GeminiWebClient from '../clients/gemini-web/index.mjs'
import { protocolError } from '../clients/gemini-web/protocol.mjs'
import { getGeminiContinuationRevision } from './gemini-web-continuation.mjs'

function resolveConversationForTurn(session) {
  if (Object.hasOwn(session, 'geminiWeb_retryConversation')) {
    const retryConversation = session.geminiWeb_retryConversation
    if (
      !retryConversation ||
      typeof retryConversation !== 'object' ||
      Array.isArray(retryConversation)
    ) {
      throw protocolError('Invalid conversation state. Start a new conversation.')
    }
    return retryConversation
  }
  return session.geminiWeb_conversation ?? session.bard_conversationObj ?? {}
}

function getPreTurnConversation(conversation, conversationObj) {
  const previousConversation = { ...conversation }
  delete previousConversation.accountId
  if (
    !Object.hasOwn(previousConversation, 'accountPath') &&
    typeof conversationObj?.accountPath === 'string'
  ) {
    previousConversation.accountPath = conversationObj.accountPath
  }
  return previousConversation
}

function hasRemoteContinuation(conversation) {
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) return false
  const nonempty = (value) => value != null && value !== ''
  return (
    ['c', 'r', 'rc'].some((key) => nonempty(conversation[key])) ||
    (Array.isArray(conversation.metadata) && conversation.metadata.some(nonempty))
  )
}

function latchUnsafeRevision(connectionPort, revision) {
  if (revision) (connectionPort._geminiUnsafeRevisions ??= new Set()).add(revision)
}

function persistUnsafeConversation(port, connectionPort, session, revision) {
  latchUnsafeRevision(connectionPort, revision)
  session.geminiWeb_conversationUnsafe = true
  try {
    port.postMessage({ geminiWebConversationUnsafe: true })
  } catch {
    // The current request error/abort remains authoritative if the port disconnected too.
  }
}

function servedModelMatchesRequested(
  requestedModel,
  extendedThinking,
  diagnostics,
  expectedRouting,
) {
  if (requestedModel === 'auto') return true
  const expectedModelNumber = GEMINI_WEB_MODEL_NUMBERS[requestedModel]
  const numericServedModelNumber = Number.isInteger(diagnostics?.servedModelNumber)
    ? diagnostics.servedModelNumber
    : undefined
  let servedModelNumber = numericServedModelNumber
  if (servedModelNumber === undefined) {
    const label = String(diagnostics?.servedModelLabel || '').toLowerCase()
    if (/\bpro\b/.test(label)) servedModelNumber = 3
    else if (/\bflash[\s_-]+lite\b/.test(label)) servedModelNumber = 6
    else if (/\bflash\b/.test(label)) servedModelNumber = 1
    else if (/\bthinking\b/.test(label)) servedModelNumber = 5
  }
  if (servedModelNumber !== undefined && servedModelNumber !== expectedModelNumber) return false
  if (
    diagnostics?.servedModelId &&
    expectedRouting?.id &&
    diagnostics.servedModelId !== expectedRouting.id
  ) {
    return false
  }
  if (
    requestedModel !== 'thinking' &&
    Number.isInteger(diagnostics?.servedModelVariant) &&
    diagnostics.servedModelVariant !== (extendedThinking ? 2 : 1)
  ) {
    return false
  }
  return true
}

function validateAndLogGeminiDiagnostics(requestedModel, extendedThinking, diagnostics, routing) {
  if (!diagnostics || typeof diagnostics !== 'object') return
  const safeDiagnostics = {
    requestedModel,
    extendedThinking,
    servedModelId: diagnostics.servedModelId,
    servedModelLabel: diagnostics.servedModelLabel,
    servedModelNumber: diagnostics.servedModelNumber,
    servedModelVariant: diagnostics.servedModelVariant,
    providerStatusCodes: diagnostics.providerStatusCodes,
  }
  if (!servedModelMatchesRequested(requestedModel, extendedThinking, diagnostics, routing)) {
    console.warn('[gemini-web] Gemini served a different model than requested', safeDiagnostics)
    return protocolError('The selected model is not available for this Google account.')
  }
  console.debug('[gemini-web] generation diagnostics', safeDiagnostics)
  return null
}

export async function generateAnswersWithGeminiWebApi(
  port,
  question,
  session,
  config = {},
  isLatestSessionRequest = () => true,
  connectionPort = port,
  continuationGuard,
) {
  const hasRetryConversation = Object.hasOwn(session, 'geminiWeb_retryConversation')
  const conversation = resolveConversationForTurn(session)
  const hasContinuation = hasRemoteContinuation(conversation)
  const storedConversation = session.geminiWeb_conversation ?? session.bard_conversationObj ?? {}
  const hasStoredContinuation = hasRemoteContinuation(storedConversation)
  const revision = getGeminiContinuationRevision(storedConversation)
  if (revision && connectionPort._geminiPendingRevisions?.has(revision)) {
    throw protocolError(
      'The previous Gemini request may have changed the remote conversation. Start a new ChatGPTBox conversation.',
    )
  }
  const conversationUnsafe =
    connectionPort._geminiUnsafeRevisions?.has(revision) === true ||
    session.geminiWeb_conversationUnsafe === true ||
    session.geminiWeb_conversationPending === true
  const retryUsesUnsafeContinuation = hasRetryConversation && conversationUnsafe && hasContinuation
  if (!hasRetryConversation && !hasContinuation && !hasStoredContinuation) {
    delete session.geminiWeb_conversationUnsafe
    delete session.geminiWeb_conversationPending
  } else if (conversationUnsafe && (!hasRetryConversation || retryUsesUnsafeContinuation)) {
    persistUnsafeConversation(port, connectionPort, session, revision)
    throw protocolError(
      'The previous Gemini request may have changed the remote conversation. ' +
        'Start a new ChatGPTBox conversation.',
    )
  }
  const legacyMode =
    !session.apiMode && session.modelName?.startsWith('bardWebFree-')
      ? { customName: session.modelName.slice('bardWebFree-'.length) }
      : null
  const preset = resolveGeminiWebPreset(session.apiMode ?? legacyMode, config)
  if (preset.source === 'invalid') {
    throw protocolError('Invalid Gemini Web model selection.')
  }
  const { model, extendedThinking } = preset
  const { controller, cleanController, isCurrentSessionRequest } = setAbortController(port)
  let promptSubmitted = false
  let reservation
  let safeRejection = false
  let notifySafe = false
  let provisionalPending = false
  let terminalStatusObserved = false
  const abortSupersededRequest = () => {
    // The persisted reservation already blocks concurrent reuse. Without a guard,
    // keep provisional state separate from confirmed unsafe revisions.
    if (
      promptSubmitted &&
      hasContinuation &&
      !safeRejection &&
      !reservation &&
      revision &&
      !provisionalPending
    ) {
      ;(connectionPort._geminiPendingRevisions ??= new Set()).add(revision)
      provisionalPending = true
    }
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('The operation was superseded.', 'AbortError'))
    }
  }
  connectionPort._abortSupersededSessionRequest = abortSupersededRequest
  const client = new GeminiWebClient()
  const isRequestCurrent = () => isCurrentSessionRequest() && isLatestSessionRequest()
  try {
    if (hasContinuation && continuationGuard) {
      reservation = await continuationGuard.begin(storedConversation, conversation)
    }
    const { answer, conversationObj, diagnostics } = await client.ask(
      question,
      conversation,
      controller.signal,
      {
        model,
        temporary: config.disableWebModeHistory === true,
        extendedThinking,
        isRequestCurrent,
        onPromptSubmitted: () => {
          promptSubmitted = true
          if (hasContinuation) {
            try {
              port.postMessage({ geminiWebContinuationSubmitted: true })
            } catch {
              // The request error/abort still decides whether the continuation becomes unsafe.
            }
          }
        },
      },
    )
    if (controller.signal.aborted || !isRequestCurrent()) {
      if (promptSubmitted && hasContinuation) {
        persistUnsafeConversation(port, connectionPort, session, revision)
      }
      return
    }
    const diagnosticsError = validateAndLogGeminiDiagnostics(
      model,
      extendedThinking,
      diagnostics,
      conversationObj?.modelState?.routing,
    )
    if (diagnosticsError) {
      if (hasContinuation) {
        // The remote turn may have advanced on a different model. Keep the last known-good
        // local continuation unchanged and latch it unsafe rather than storing unusable state.
        diagnosticsError.geminiWebConversationUncertain = true
      }
      throw diagnosticsError
    }
    // A completed answer remains usable, but a terminal status is not proof that
    // the returned remote continuation can be reused.
    terminalStatusObserved = diagnostics?.providerStatusCodes?.includes(1096) === true
    if (reservation && !terminalStatusObserved) await reservation.complete(conversationObj)
    if (terminalStatusObserved && !reservation && continuationGuard) {
      try {
        reservation = await continuationGuard.begin(conversationObj, conversationObj)
      } catch {
        // Keep the completed answer and mark the local continuation unsafe even if
        // the background cannot persist a reservation for this first turn.
        console.warn('[gemini-web] Could not persist terminal continuation status')
      }
    }
    if (controller.signal.aborted || !isRequestCurrent()) {
      if (hasContinuation) persistUnsafeConversation(port, connectionPort, session, revision)
      return
    }
    session.geminiWeb_previousConversation = getPreTurnConversation(conversation, conversationObj)
    session.geminiWeb_conversation = conversationObj
    delete session.geminiWeb_retryConversation
    delete session.bard_conversationObj
    pushRecord(session, question, answer)
    session.geminiWeb_lastRecordIndex = session.conversationRecords.length - 1
    if (terminalStatusObserved) {
      session.geminiWeb_conversationUnsafe = true
      latchUnsafeRevision(connectionPort, revision)
      latchUnsafeRevision(connectionPort, getGeminiContinuationRevision(conversationObj))
    } else {
      delete session.geminiWeb_conversationUnsafe
      connectionPort._geminiUnsafeRevisions?.delete(revision)
    }
    delete session.geminiWeb_conversationPending
    delete session.geminiWeb_pendingRequestId
    port.postMessage({ answer, done: true, session })
  } catch (error) {
    safeRejection =
      !error?.geminiWebConversationUncertain &&
      (error?.geminiWebDefinitiveRejection === true ||
        (error?.geminiWebProviderRejection === true &&
          error?.geminiWebRemoteStateObserved !== true))
    if (
      hasContinuation &&
      (error?.geminiWebConversationUncertain || (promptSubmitted && !safeRejection))
    ) {
      persistUnsafeConversation(port, connectionPort, session, revision)
    } else if (
      hasContinuation &&
      (!continuationGuard || reservation) &&
      !controller.signal.aborted &&
      !connectionPort._geminiUnsafeRevisions?.has(revision)
    ) {
      notifySafe = true
    }
    throw error
  } finally {
    if (reservation) {
      try {
        await reservation.release({
          safe: !terminalStatusObserved && (!promptSubmitted || safeRejection),
        })
      } catch {
        notifySafe = false
        console.warn('[gemini-web] Could not resolve the persisted continuation guard')
      }
    }
    if (provisionalPending) connectionPort._geminiPendingRevisions?.delete(revision)
    if (notifySafe) {
      try {
        port.postMessage({ geminiWebContinuationSafe: true })
      } catch {
        // Preserve the original request error.
      }
    }
    if (connectionPort._abortSupersededSessionRequest === abortSupersededRequest) {
      delete connectionPort._abortSupersededSessionRequest
    }
    cleanController()
  }
}
