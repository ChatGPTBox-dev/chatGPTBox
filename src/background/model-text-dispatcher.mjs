import { initSession } from '../services/init-session.mjs'
import {
  isUsingAimlApiModel,
  isUsingAzureOpenAiApiModel,
  isUsingBingWebModel,
  isUsingChatGLMApiModel,
  isUsingChatgptApiModel,
  isUsingChatgptWebModel,
  isUsingClaudeApiModel,
  isUsingClaudeWebModel,
  isUsingCustomModel,
  isUsingDeepSeekApiModel,
  isUsingGeminiWebModel,
  isUsingGithubThirdPartyApiModel,
  isUsingGoogleApiModel,
  isUsingGptCompletionApiModel,
  isUsingMistralApiModel,
  isUsingMoonshotApiModel,
  isUsingMoonshotWebModel,
  isUsingNvidiaNimApiModel,
  isUsingOllamaApiModel,
  isUsingOpenRouterApiModel,
  isUsingXaiApiModel,
} from '../config/index.mjs'
import { isUsingModelName } from '../utils/model-name-convert.mjs'

const DEFAULT_MAX_OUTPUT_TOKENS = 20_000
const MIN_MAX_OUTPUT_TOKENS = 1
const MAX_MAX_OUTPUT_TOKENS = 40_000

function createListenerSet() {
  const listeners = new Set()
  return {
    addListener(listener) {
      if (typeof listener === 'function') listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    emit(payload) {
      for (const listener of Array.from(listeners)) listener(payload)
    },
    clear() {
      listeners.clear()
    },
  }
}

function cloneSerializable(value, fallback) {
  if (value === undefined) return fallback
  try {
    return structuredClone(value)
  } catch {
    return fallback
  }
}

function cloneModelSnapshot(modelSnapshot) {
  if (!modelSnapshot || typeof modelSnapshot !== 'object') return {}
  return {
    ...modelSnapshot,
    apiMode:
      modelSnapshot.apiMode && typeof modelSnapshot.apiMode === 'object'
        ? { ...modelSnapshot.apiMode }
        : modelSnapshot.apiMode,
  }
}

function normalizeMaxOutputTokens(maxOutputTokens, config) {
  const fallback = Number(config?.maxResponseTokenLength) || DEFAULT_MAX_OUTPUT_TOKENS
  const requested = Number(maxOutputTokens) || fallback
  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, Math.trunc(requested)))
}

function createSafeGatewayError(code, { condition = null, modelName = null } = {}) {
  const error = new Error(code)
  error.code = code
  error.operation = 'generateText'
  if (condition) error.condition = condition
  if (modelName) error.modelName = modelName
  return error
}

function isAbortError(error) {
  return (
    error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.message === 'AbortError'
  )
}

function isKnownLoginError(error) {
  const message = String(error?.message || error || '')
  return ['UNAUTHORIZED', 'CLOUDFLARE', 'Invalid authorization', 'Session key required'].some(
    (part) => message.includes(part),
  )
}

function buildLogContext({ event, route, modelSnapshot, errorCode }) {
  return {
    event,
    route,
    modelName: modelSnapshot?.modelName || null,
    apiModeGroup: modelSnapshot?.apiMode?.groupName || null,
    providerId: modelSnapshot?.apiMode?.providerId || null,
    ...(errorCode ? { errorCode } : {}),
  }
}

function isUsingOpenAICompatibleApiSession(session) {
  return (
    isUsingCustomModel(session) ||
    isUsingChatgptApiModel(session) ||
    isUsingMoonshotApiModel(session) ||
    isUsingMistralApiModel(session) ||
    isUsingChatGLMApiModel(session) ||
    isUsingDeepSeekApiModel(session) ||
    isUsingNvidiaNimApiModel(session) ||
    isUsingOllamaApiModel(session) ||
    isUsingOpenRouterApiModel(session) ||
    isUsingAimlApiModel(session) ||
    isUsingGoogleApiModel(session) ||
    isUsingXaiApiModel(session) ||
    isUsingGptCompletionApiModel(session)
  )
}

function messagesToQuestion(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => typeof message?.content === 'string' && message.content.trim())
    .map((message) => `<${message.role || 'user'}>\n${message.content.trim()}`)
    .join('\n\n')
}

function createIsolatedGenerationPort({ signal, onMessage, onAbort }) {
  const messageListeners = createListenerSet()
  const disconnectListeners = createListenerSet()
  let disconnected = false
  const abortListener = () => {
    onAbort?.()
    messageListeners.emit({ stop: true })
  }
  const port = {
    _stopAcknowledged: false,
    onMessage: messageListeners,
    onDisconnect: disconnectListeners,
    postMessage(message) {
      onMessage(message)
    },
    disconnect() {
      if (disconnected) return
      disconnected = true
      signal?.removeEventListener?.('abort', abortListener)
      disconnectListeners.emit()
      messageListeners.clear()
      disconnectListeners.clear()
    },
  }
  if (signal?.aborted) {
    queueMicrotask(abortListener)
  } else {
    signal?.addEventListener?.('abort', abortListener, { once: true })
  }
  return port
}

function createTerminalTracker({ signal, modelName }) {
  let latestText = ''
  let settled = false
  let resolveResult
  let rejectResult
  const terminalPromise = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const settleResolve = () => {
    if (settled) return
    settled = true
    resolveResult({ text: latestText, finishReason: null })
  }
  const settleReject = (error) => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  return {
    get settled() {
      return settled
    },
    get latestText() {
      return latestText
    },
    promise: terminalPromise,
    handlePortMessage(message) {
      if (settled) return
      if (signal?.aborted) {
        settleReject(createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName }))
        return
      }
      if (typeof message?.answer === 'string') latestText = message.answer
      if (message?.error !== undefined) {
        settleReject(createSafeGatewayError('MODEL_GATEWAY_PROVIDER_ERROR', { modelName }))
        return
      }
      if (message?.done) settleResolve()
    },
    abort() {
      settleReject(createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName }))
    },
    fail(error) {
      settleReject(error)
    },
    completeIfPending() {
      settleResolve()
    },
  }
}

function routeName(route) {
  return route || 'unknown'
}

function requireLogin(modelName) {
  throw createSafeGatewayError('MODEL_LOGIN_REQUIRED', {
    condition: 'login-required',
    modelName,
  })
}

function requireProviderPage(modelName) {
  throw createSafeGatewayError('MODEL_GATEWAY_PROVIDER_PAGE_REQUIRED', {
    condition: 'provider-page-required',
    modelName,
  })
}

async function callRoutedAdapter({ dependencies, route, port, question, session, config }) {
  const modelName = session.modelName
  switch (route) {
    case 'chatgpt-web-page':
      if (typeof dependencies.generateWithChatgptPageProxy !== 'function')
        requireProviderPage(modelName)
      await dependencies.generateWithChatgptPageProxy({
        port,
        question,
        session,
        tabId: config.chatgptTabId,
        config,
      })
      return
    case 'chatgpt-web-direct': {
      const accessToken = await dependencies.getChatGptAccessToken()
      if (!accessToken) requireLogin(modelName)
      await dependencies.generateAnswersWithChatgptWebApi(
        port,
        question,
        session,
        accessToken,
        config,
      )
      return
    }
    case 'claude-web': {
      const sessionKey = await dependencies.getClaudeSessionKey()
      if (!sessionKey) requireLogin(modelName)
      await dependencies.generateAnswersWithClaudeWebApi(
        port,
        question,
        session,
        sessionKey,
        config,
      )
      return
    }
    case 'kimi-web':
      if (!config.kimiMoonShotRefreshToken) requireLogin(modelName)
      await dependencies.generateAnswersWithMoonshotWebApi(port, question, session, config)
      return
    case 'bing-web': {
      const accessToken = await dependencies.getBingAccessToken()
      if (!accessToken) requireLogin(modelName)
      await dependencies.generateAnswersWithBingWebApi(
        port,
        question,
        session,
        accessToken,
        isUsingModelName('bingFreeSydney', session),
        config,
      )
      return
    }
    case 'gemini-web': {
      const cookies = await dependencies.getBardCookies()
      if (!cookies || cookies.endsWith('=undefined')) requireLogin(modelName)
      await dependencies.generateAnswersWithBardWebApi(port, question, session, cookies, () => true)
      return
    }
    case 'openai-compatible':
      await dependencies.generateAnswersWithOpenAICompatibleApi(port, question, session, config)
      return
    case 'claude-api':
      await dependencies.generateAnswersWithClaudeApi(port, question, session, config)
      return
    case 'azure-openai':
      await dependencies.generateAnswersWithAzureOpenaiApi(port, question, session, config)
      return
    case 'github-third-party':
      await dependencies.generateAnswersWithWaylaidwandererApi(port, question, session, config)
      return
    default:
      throw createSafeGatewayError('MODEL_GATEWAY_UNSUPPORTED', { modelName })
  }
}

function selectRoute(session, config) {
  if (isUsingChatgptWebModel(session)) {
    return config.chatgptTabId ? 'chatgpt-web-page' : 'chatgpt-web-direct'
  }
  if (isUsingClaudeWebModel(session)) return 'claude-web'
  if (isUsingMoonshotWebModel(session)) return 'kimi-web'
  if (isUsingBingWebModel(session)) return 'bing-web'
  if (isUsingGeminiWebModel(session)) return 'gemini-web'
  if (isUsingOpenAICompatibleApiSession(session)) return 'openai-compatible'
  if (isUsingClaudeApiModel(session)) return 'claude-api'
  if (isUsingAzureOpenAiApiModel(session)) return 'azure-openai'
  if (isUsingGithubThirdPartyApiModel(session)) return 'github-third-party'
  return 'unsupported'
}

function normalizeThrownError(error, modelName) {
  if (
    error?.code &&
    [
      'MODEL_LOGIN_REQUIRED',
      'MODEL_GATEWAY_PROVIDER_PAGE_REQUIRED',
      'MODEL_GATEWAY_UNSUPPORTED',
      'MODEL_GATEWAY_ABORTED',
      'MODEL_GATEWAY_PROVIDER_ERROR',
    ].includes(error.code)
  ) {
    return error
  }
  if (isAbortError(error)) {
    return createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
  }
  if (isKnownLoginError(error)) {
    return createSafeGatewayError('MODEL_LOGIN_REQUIRED', {
      condition: 'login-required',
      modelName,
    })
  }
  return createSafeGatewayError('MODEL_GATEWAY_GENERATION_FAILED', { modelName })
}

export function createModelTextDispatcher(dependencies) {
  return {
    async generateText({ modelSnapshot, messages, maxOutputTokens, signal } = {}) {
      const immutableSnapshot = cloneModelSnapshot(modelSnapshot)
      let session
      let route = 'unknown'
      let port
      let tracker
      try {
        const userConfig = await dependencies.getUserConfig()
        const config = {
          ...cloneSerializable(userConfig, {}),
          maxResponseTokenLength: normalizeMaxOutputTokens(maxOutputTokens, userConfig),
        }
        const question = messagesToQuestion(cloneSerializable(messages, []))
        session = initSession({
          question,
          conversationRecords: [],
          modelName: immutableSnapshot?.modelName || config.modelName,
          apiMode: immutableSnapshot?.apiMode ?? config.apiMode,
          autoClean: true,
        })
        route = selectRoute(session, config)
        tracker = createTerminalTracker({ signal, modelName: session.modelName })
        port = createIsolatedGenerationPort({
          signal,
          onMessage: (message) => tracker.handlePortMessage(message),
          onAbort: () => tracker.abort(),
        })

        dependencies.logger?.info?.(
          buildLogContext({
            event: 'model-text-dispatcher.generateText',
            route: routeName(route),
            modelSnapshot: immutableSnapshot,
          }),
        )

        const adapterPromise = callRoutedAdapter({
          dependencies,
          route,
          port,
          question,
          session,
          config,
        }).then(
          () => {
            if (!tracker.settled) tracker.completeIfPending()
          },
          (error) => {
            tracker.fail(normalizeThrownError(error, session.modelName))
          },
        )

        const result = await Promise.race([
          tracker.promise,
          adapterPromise.then(() => tracker.promise),
        ])
        dependencies.logger?.info?.(
          buildLogContext({
            event: 'model-text-dispatcher.generateText.complete',
            route: routeName(route),
            modelSnapshot: immutableSnapshot,
          }),
        )
        return result
      } catch (error) {
        const normalized = normalizeThrownError(
          error,
          session?.modelName || immutableSnapshot?.modelName,
        )
        dependencies.logger?.warn?.(
          buildLogContext({
            event: 'model-text-dispatcher.generateText.failed',
            route: routeName(route),
            modelSnapshot: immutableSnapshot,
            errorCode: normalized.code || normalized.message || 'MODEL_GATEWAY_ERROR',
          }),
        )
        throw normalized
      } finally {
        port?.disconnect()
      }
    },
  }
}
