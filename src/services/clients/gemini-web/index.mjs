import { parseAnswer, protocolError } from './protocol.mjs'
import {
  getAbortReason,
  getGeminiRequestParams,
  requestGeminiText,
  throwIfAborted,
} from '../../apis/gemini-web-transport.mjs'

const REQUEST_TIMEOUT = 240000

function validateConversationRoute(conversation) {
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
      if (controller.signal.aborted) throw abortReason
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async send(prompt, conversationObj, signal, options = {}) {
    throwIfAborted(signal)
    validateConversationRoute(conversationObj)
    const params = await this.getRequestParams(signal, conversationObj.accountPath)
    const text = await requestGeminiText(prompt, conversationObj, params, options, signal)
    const result = this.parseResponse(text)
    throwIfAborted(signal)
    result.conversationObj.accountPath = params.accountPath
    return result
  }
}
