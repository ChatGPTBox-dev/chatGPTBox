import { parseAnswer, protocolError } from './protocol.mjs'
import {
  GEMINI_WEB_MODEL_NUMBERS,
  getAbortReason,
  getGeminiRequestParams,
  normalizeRequestedGeminiWebModel,
  requestGeminiText,
  throwIfAborted,
} from '../../apis/gemini-web-transport.mjs'

const REQUEST_TIMEOUT = 240000

function requestedModelState(options = {}) {
  const model = normalizeRequestedGeminiWebModel(options.model)
  return {
    model,
    extendedThinking: !['auto', 'thinking'].includes(model) && options.extendedThinking === true,
  }
}

function validateConversationRoute(conversation, options = {}) {
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
    throw protocolError('Invalid conversation state. Start a new conversation.')
  }
  if (conversation.metadata != null && !Array.isArray(conversation.metadata)) {
    throw protocolError('Invalid conversation state. Start a new conversation.')
  }
  const nonempty = (value) => value != null && value !== ''
  const hasContinuation =
    ['c', 'r', 'rc'].some((key) => nonempty(conversation[key])) ||
    (Array.isArray(conversation.metadata) && conversation.metadata.some(nonempty))
  if (!hasContinuation) return
  if (
    !Object.prototype.hasOwnProperty.call(conversation, 'accountPath') ||
    typeof conversation.accountPath !== 'string'
  ) {
    throw protocolError(
      'This conversation has no stored Google account route. Start a new conversation.',
    )
  }
  const continuationIds = ['c', 'r', 'rc'].map(
    (key, index) => conversation[key] || conversation.metadata?.[index],
  )
  if (!continuationIds.every((value) => typeof value === 'string' && value)) {
    throw protocolError('Invalid conversation state. Start a new conversation.')
  }

  const modelState = conversation.modelState
  const expectedModelState = requestedModelState(options)
  if (!modelState || typeof modelState !== 'object' || Array.isArray(modelState)) {
    throw protocolError('This conversation has no stored Gemini model. Start a new conversation.')
  }
  if (
    modelState.model !== expectedModelState.model ||
    modelState.extendedThinking !== expectedModelState.extendedThinking
  ) {
    throw protocolError(
      'The selected model does not match this conversation. Start a new conversation.',
    )
  }
  if (expectedModelState.model !== 'auto') {
    if (
      !modelState.routing ||
      typeof modelState.routing !== 'object' ||
      Array.isArray(modelState.routing)
    ) {
      throw protocolError('This conversation has no stored Gemini model. Start a new conversation.')
    }
    const expectedModelNumber = GEMINI_WEB_MODEL_NUMBERS[expectedModelState.model]
    if (modelState.routing.modelNumber !== expectedModelNumber) {
      throw protocolError('Invalid conversation state. Start a new conversation.')
    }
  }
  if (!Number.isInteger(conversation.turnIndex) || conversation.turnIndex < 1) {
    throw protocolError('Invalid conversation state. Start a new conversation.')
  }
}

export default class GeminiWebClient {
  parseResponse(text) {
    return parseAnswer(text)
  }

  async getRequestParams(signal, accountPath) {
    return getGeminiRequestParams(signal, accountPath)
  }

  async ask(prompt, conversationObj = {}, signal, options = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw protocolError('Empty question.')
    throwIfAborted(signal)
    const controller = new AbortController()
    let abortReason
    const abort = (reason) => {
      if (controller.signal.aborted) return
      abortReason = reason
      controller.abort(reason)
    }
    const onAbort = () => abort(getAbortReason(signal))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      abort(protocolError('Request timed out. Check Gemini before retrying.'))
    }, REQUEST_TIMEOUT)
    try {
      return await this.send(prompt, conversationObj, controller.signal, options)
    } catch (error) {
      if (controller.signal.aborted) {
        if (
          error?.geminiWebConversationUncertain &&
          abortReason &&
          typeof abortReason === 'object'
        ) {
          abortReason.geminiWebConversationUncertain = true
        }
        throw abortReason
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async send(prompt, conversationObj, signal, options = {}) {
    throwIfAborted(signal)
    validateConversationRoute(conversationObj, options)
    const params = await this.getRequestParams(signal, conversationObj.accountPath)
    const { text, modelState } = await requestGeminiText(
      prompt,
      conversationObj,
      params,
      options,
      signal,
    )
    let result
    try {
      result = this.parseResponse(text)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        error.code === 'GEMINI_WEB_PROTOCOL_ERROR' &&
        (error.geminiWebProviderRejection !== true || error.geminiWebRemoteStateObserved === true)
      ) {
        error.geminiWebConversationUncertain = true
      }
      throw error
    }
    if (signal?.aborted) {
      const abortError = getAbortReason(signal)
      if (abortError && typeof abortError === 'object') {
        try {
          abortError.geminiWebConversationUncertain = true
        } catch {
          // Preserve the original abort reason if the browser error object is non-extensible.
        }
      }
      throw abortError
    }
    const submittedConversationId = conversationObj.c || conversationObj.metadata?.[0]
    if (
      typeof submittedConversationId === 'string' &&
      submittedConversationId &&
      result.conversationObj.c !== submittedConversationId
    ) {
      const error = protocolError('Conversation identifiers changed during generation.')
      error.geminiWebConversationUncertain = true
      throw error
    }
    result.conversationObj.accountPath = params.accountPath
    result.conversationObj.modelState = modelState
    result.conversationObj.turnIndex =
      (Number.isInteger(conversationObj.turnIndex) ? conversationObj.turnIndex : 0) + 1
    return result
  }
}
