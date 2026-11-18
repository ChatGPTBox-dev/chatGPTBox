import { resolveGeminiWebPreset } from '../../utils/gemini-web-preset.mjs'
import { GEMINI_WEB_MODEL_NUMBERS } from './gemini-web-transport.mjs'
import { pushRecord, setAbortController } from './shared.mjs'
import GeminiWebClient from '../clients/gemini-web/index.mjs'
import { protocolError } from '../clients/gemini-web/protocol.mjs'

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

function persistUnsafeConversation(port, connectionPort, session) {
  connectionPort._geminiConversationUnsafe = true
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
    if (label.includes('thinking')) servedModelNumber = 5
    else if (label.includes('pro')) servedModelNumber = 3
    else if (label.includes('flash') && label.includes('lite')) servedModelNumber = 6
    else if (label.includes('flash')) servedModelNumber = 1
  }
  if (servedModelNumber !== undefined && servedModelNumber !== expectedModelNumber) return false
  if (
    numericServedModelNumber === undefined &&
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
) {
  const hasRetryConversation = Object.hasOwn(session, 'geminiWeb_retryConversation')
  const conversation = resolveConversationForTurn(session)
  const hasContinuation = hasRemoteContinuation(conversation)
  const storedConversation = session.geminiWeb_conversation ?? session.bard_conversationObj ?? {}
  const hasStoredContinuation = hasRemoteContinuation(storedConversation)
  const conversationUnsafe =
    connectionPort._geminiConversationUnsafe === true ||
    session.geminiWeb_conversationUnsafe === true ||
    session.geminiWeb_conversationPending === true
  const retryUsesUnsafeContinuation = hasRetryConversation && conversationUnsafe && hasContinuation
  if (!hasRetryConversation && !hasContinuation && !hasStoredContinuation) {
    delete connectionPort._geminiConversationUnsafe
    delete session.geminiWeb_conversationUnsafe
    delete session.geminiWeb_conversationPending
  } else if (conversationUnsafe && (!hasRetryConversation || retryUsesUnsafeContinuation)) {
    persistUnsafeConversation(port, connectionPort, session)
    throw protocolError(
      'The previous Gemini request may have changed the remote conversation. ' +
        'Start a new ChatGPTBox conversation.',
    )
  }
  const preset = resolveGeminiWebPreset(session?.apiMode, config)
  if (preset.source === 'invalid') {
    throw protocolError('Invalid Gemini Web model selection.')
  }
  const { model, extendedThinking } = preset
  const { controller, cleanController, isCurrentSessionRequest } = setAbortController(port)
  let promptSubmitted = false
  const abortSupersededRequest = () => {
    if (promptSubmitted && hasContinuation) {
      connectionPort._geminiConversationUnsafe = true
    }
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('The operation was superseded.', 'AbortError'))
    }
  }
  connectionPort._abortSupersededSessionRequest = abortSupersededRequest
  const client = new GeminiWebClient()
  const isRequestCurrent = () => isCurrentSessionRequest() && isLatestSessionRequest()
  try {
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
        persistUnsafeConversation(port, connectionPort, session)
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
        persistUnsafeConversation(port, connectionPort, session)
      }
      throw diagnosticsError
    }
    session.geminiWeb_previousConversation = getPreTurnConversation(conversation, conversationObj)
    session.geminiWeb_conversation = conversationObj
    delete session.geminiWeb_retryConversation
    delete session.bard_conversationObj
    pushRecord(session, question, answer)
    session.geminiWeb_lastRecordIndex = session.conversationRecords.length - 1
    delete session.geminiWeb_conversationUnsafe
    delete session.geminiWeb_conversationPending
    delete connectionPort._geminiConversationUnsafe
    port.postMessage({ answer, done: true, session })
  } catch (error) {
    if (error?.geminiWebConversationUncertain && hasContinuation) {
      persistUnsafeConversation(port, connectionPort, session)
    } else if (
      hasContinuation &&
      !error?.geminiWebConversationUncertain &&
      !controller.signal.aborted &&
      connectionPort._geminiConversationUnsafe !== true
    ) {
      try {
        port.postMessage({ geminiWebContinuationSafe: true })
      } catch {
        // Preserve the original request error.
      }
    }
    throw error
  } finally {
    if (connectionPort._abortSupersededSessionRequest === abortSupersededRequest) {
      delete connectionPort._abortSupersededSessionRequest
    }
    cleanController()
  }
}
