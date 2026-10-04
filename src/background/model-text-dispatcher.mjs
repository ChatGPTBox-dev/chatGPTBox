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
let consoleSuppressionDepth = 0
let suppressedConsoleDescriptors = null

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

function createSafeGatewayError(
  code,
  { condition = null, modelName = null, trustedHumanMessage = null } = {},
) {
  const error = new Error(code)
  error.code = code
  error.operation = 'generateText'
  if (condition) error.condition = condition
  if (modelName) error.modelName = modelName
  if (trustedHumanMessage) {
    Object.defineProperty(error, 'trustedHumanMessage', {
      value: trustedHumanMessage,
      enumerable: false,
      configurable: true,
    })
  }
  return error
}

async function suppressConsoleDiagnostics(callback, { signal, modelName } = {}) {
  if (signal?.aborted) throw createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
  const methodNames = ['debug', 'info', 'warn', 'error', 'log']
  if (consoleSuppressionDepth === 0) {
    suppressedConsoleDescriptors = Object.fromEntries(
      methodNames.map((name) => [name, Object.getOwnPropertyDescriptor(console, name)]),
    )
  }
  for (const name of methodNames) {
    Object.defineProperty(console, name, {
      value: () => {},
      writable: true,
      enumerable: suppressedConsoleDescriptors?.[name]?.enumerable ?? true,
      configurable: true,
    })
  }
  consoleSuppressionDepth += 1
  let abortListener
  const abortPromise = new Promise((_, reject) => {
    abortListener = () => reject(createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName }))
    signal?.addEventListener?.('abort', abortListener, { once: true })
  })
  const workPromise = Promise.resolve().then(callback)
  workPromise.catch(() => {})
  try {
    return await (signal ? Promise.race([workPromise, abortPromise]) : workPromise)
  } finally {
    signal?.removeEventListener?.('abort', abortListener)
    consoleSuppressionDepth -= 1
    if (consoleSuppressionDepth === 0 && suppressedConsoleDescriptors) {
      for (const name of methodNames) {
        const descriptor = suppressedConsoleDescriptors[name]
        if (descriptor) Object.defineProperty(console, name, descriptor)
      }
      suppressedConsoleDescriptors = null
    } else if (consoleSuppressionDepth > 0) {
      for (const name of methodNames) {
        Object.defineProperty(console, name, {
          value: () => {},
          writable: true,
          enumerable: suppressedConsoleDescriptors?.[name]?.enumerable ?? true,
          configurable: true,
        })
      }
    }
  }
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
  let finishReason = null
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
    resolveResult({ text: latestText, finishReason })
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
      if (typeof message?.finishReason === 'string') finishReason = message.finishReason
      if (message?.error !== undefined) {
        settleReject(
          createSafeGatewayError('MODEL_GATEWAY_PROVIDER_ERROR', {
            modelName,
            trustedHumanMessage: typeof message.error === 'string' ? message.error : null,
          }),
        )
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
  throw createSafeGatewayError('MODEL_PROVIDER_PAGE_REQUIRED', {
    condition: 'provider-page-required',
    modelName,
  })
}

async function callRoutedAdapter({
  dependencies,
  route,
  port,
  question,
  session,
  config,
  requestId,
  signal,
}) {
  const modelName = session.modelName
  if (signal?.aborted) throw createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
  switch (route) {
    case 'chatgpt-web-page': {
      if (typeof dependencies.generateWithChatgptPageProxy !== 'function')
        requireProviderPage(modelName)
      const result = await dependencies.generateWithChatgptPageProxy({
        requestId,
        session,
        signal,
      })
      if (signal?.aborted) throw createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
      port.postMessage({
        answer: typeof result?.text === 'string' ? result.text : '',
        done: true,
        finishReason: result?.finishReason ?? null,
      })
      return
    }
    case 'chatgpt-web-direct': {
      const accessToken = await dependencies.getChatGptAccessToken()
      if (signal?.aborted) throw createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
      if (!accessToken) requireLogin(modelName)
      await suppressConsoleDiagnostics(
        () =>
          dependencies.generateAnswersWithChatgptWebApi(
            port,
            question,
            session,
            accessToken,
            config,
          ),
        { signal, modelName },
      )
      return
    }
    case 'claude-web': {
      const sessionKey = await dependencies.getClaudeSessionKey()
      if (signal?.aborted) throw createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
      if (!sessionKey) requireLogin(modelName)
      await suppressConsoleDiagnostics(
        () =>
          dependencies.generateAnswersWithClaudeWebApi(port, question, session, sessionKey, config),
        { signal, modelName },
      )
      return
    }
    case 'kimi-web':
      if (!config.kimiMoonShotRefreshToken) requireLogin(modelName)
      await suppressConsoleDiagnostics(
        () => dependencies.generateAnswersWithMoonshotWebApi(port, question, session, config),
        { signal, modelName },
      )
      return
    case 'bing-web': {
      const accessToken = await dependencies.getBingAccessToken()
      if (signal?.aborted) throw createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
      if (!accessToken) requireLogin(modelName)
      await suppressConsoleDiagnostics(
        () =>
          dependencies.generateAnswersWithBingWebApi(
            port,
            question,
            session,
            accessToken,
            isUsingModelName('bingFreeSydney', session),
            config,
          ),
        { signal, modelName },
      )
      return
    }
    case 'gemini-web': {
      const cookies = await dependencies.getBardCookies()
      if (signal?.aborted) throw createSafeGatewayError('MODEL_GATEWAY_ABORTED', { modelName })
      if (!cookies || cookies.endsWith('=undefined')) requireLogin(modelName)
      await suppressConsoleDiagnostics(
        () =>
          dependencies.generateAnswersWithBardWebApi(port, question, session, cookies, () => true),
        { signal, modelName },
      )
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
      'MODEL_PROVIDER_PAGE_REQUIRED',
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
    async generateText({ requestId, modelSnapshot, messages, maxOutputTokens, signal } = {}) {
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
          requestId,
          signal,
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
        if (!signal?.aborted) await adapterPromise
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
