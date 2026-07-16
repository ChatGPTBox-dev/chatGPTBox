import {
  clearOldAccessToken,
  getUserConfig,
  isUsingBingWebModel,
  isUsingClaudeWebModel,
  setAccessToken,
} from '../config/index.mjs'
import Browser from 'webextension-polyfill'
import { getFixedT, t } from 'i18next'
import {
  FETCH_REQUEST_FAILED,
  FETCH_RESPONSE_STREAM_FAILED,
  INVALID_API_ENDPOINT,
} from '../utils/fetch-sse.mjs'
import { isAbortError } from '../utils/abort-error.mjs'
import { formatErrorMessage, formatErrorText } from '../utils/error-text.mjs'
import {
  apiModeToModelName,
  modelNameToDesc,
  normalizeApiMode,
} from '../utils/model-name-convert.mjs'
import { acknowledgePortStop } from './apis/shared.mjs'

export async function getChatGptAccessToken() {
  await clearOldAccessToken()
  const userConfig = await getUserConfig()
  if (userConfig.accessToken) {
    return userConfig.accessToken
  } else {
    let cookie = ''
    if (Browser.cookies && Browser.cookies.getAll) {
      cookie = (await Browser.cookies.getAll({ url: 'https://chatgpt.com/' }))
        .map(({ name, value }) => {
          return `${name}=${value}`
        })
        .join('; ')
    }
    const resp = await fetch('https://chatgpt.com/api/auth/session', {
      credentials: 'include',
      headers: {
        ...(cookie && { Cookie: cookie }),
      },
    })
    if (resp.status === 403) {
      throw new Error('CLOUDFLARE')
    }
    const data = await resp.json().catch(() => ({}))
    if (!data.accessToken) {
      throw new Error('UNAUTHORIZED')
    }
    await setAccessToken(data.accessToken)
    return data.accessToken
  }
}

export async function getBingAccessToken() {
  return (await Browser.cookies.get({ url: 'https://bing.com/', name: '_U' }))?.value
}

export async function getBardCookies() {
  const token = (await Browser.cookies.get({ url: 'https://google.com/', name: '__Secure-1PSID' }))
    ?.value
  return '__Secure-1PSID=' + token
}

export async function getClaudeSessionKey() {
  return (await Browser.cookies.get({ url: 'https://claude.ai/', name: 'sessionKey' }))?.value
}

function isDisconnectedPortError(err) {
  if (!err || typeof err !== 'object') return false
  const message =
    typeof err.message === 'string' ? err.message.trim().toLowerCase().replace(/\.$/, '') : ''
  return (
    message === 'attempting to use a disconnected port object' ||
    message === 'attempt to postmessage on disconnected port' ||
    message === 'extension context invalidated'
  )
}

function formatErrorDetail(key, value, translate = t) {
  const label = translate(key) ?? key
  const detail = `\n\n${formatErrorText(value)}`
  return label.includes('%s') ? label.replace('%s', () => detail) : `${label}${detail}`
}

const transportErrorSummaryKeys = {
  [FETCH_REQUEST_FAILED]: 'The browser could not complete the request to the API endpoint.',
  [FETCH_RESPONSE_STREAM_FAILED]: 'The response stream from the API endpoint was interrupted.',
  [INVALID_API_ENDPOINT]: 'The configured API endpoint URL is invalid.',
}

export function handlePortError(session, port, err, translate = t) {
  const transportErrorSummaryKey = Object.prototype.hasOwnProperty.call(
    transportErrorSummaryKeys,
    err?.code,
  )
    ? transportErrorSummaryKeys[err.code]
    : undefined
  if (isAbortError(err)) return
  if (isDisconnectedPortError(err)) {
    console.warn('[handlePortError] Ignoring disconnected port error:', err.message)
    return
  }
  console.error(err)
  const postError = (error) => {
    try {
      port.postMessage({ error })
    } catch (postErr) {
      console.warn('[handlePortError] Failed to post error:', postErr)
    }
  }
  const message = typeof err?.message === 'string' ? err.message : ''
  if (transportErrorSummaryKey) {
    const details = [
      translate(transportErrorSummaryKey),
      translate('Check the API endpoint URL and service availability, then try again.'),
    ]
    if (err.requestOrigin)
      details.push(formatErrorDetail('API endpoint: %s', err.requestOrigin, translate))
    if (message) details.push(formatErrorDetail('Browser message: %s', message, translate))
    postError(details.join('\n\n'))
    return
  }
  const formattedMessage = formatErrorMessage(message)
  if (message) {
    if (
      ['message you submitted was too long', 'maximum context length'].some((m) =>
        message.includes(m),
      )
    )
      postError(translate('Exceeded maximum context length') + '\n\n' + formattedMessage)
    else if (['CaptchaChallenge', 'CAPTCHA'].some((m) => message.includes(m)))
      postError(translate('Bing CaptchaChallenge') + '\n\n' + formattedMessage)
    else if (['exceeded your current quota'].some((m) => message.includes(m)))
      postError(translate('Exceeded quota') + '\n\n' + formattedMessage)
    else if (['Rate limit reached'].some((m) => message.includes(m)))
      postError(translate('Rate limit') + '\n\n' + formattedMessage)
    else if (['authentication token has expired'].some((m) => message.includes(m)))
      postError('UNAUTHORIZED')
    else if (
      isUsingClaudeWebModel(session) &&
      ['Invalid authorization', 'Session key required'].some((m) => message.includes(m))
    )
      postError(
        translate('Please login at https://claude.ai first, and then click the retry button'),
      )
    else if (
      isUsingBingWebModel(session) &&
      ['/turing/conversation/create: failed to parse response body.'].some((m) =>
        message.includes(m),
      )
    )
      postError(translate('Please login at https://bing.com first'))
    else postError(formattedMessage)
  } else {
    const errMsg = JSON.stringify(err) ?? 'unknown error'
    if (isUsingBingWebModel(session) && errMsg.includes('isTrusted'))
      postError(translate('Please login at https://bing.com first'))
    else postError(formatErrorMessage(errMsg))
  }
}

export function claimLatestPortSessionRequest(port) {
  const requestId = (port._latestSessionRequestId ?? 0) + 1
  port._latestSessionRequestId = requestId
  port._sessionRequestGeneration = (port._sessionRequestGeneration ?? 0) + 1
  port._stopAcknowledged = false
  return () => port._latestSessionRequestId === requestId
}

export function invalidateLatestPortSessionRequest(port) {
  port._latestSessionRequestId = (port._latestSessionRequestId ?? 0) + 1
}

function createSessionRequestPort(port, proxyGenerationId, requestGenerationId) {
  const sessionRequestGeneration = port._sessionRequestGeneration
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === 'postMessage') {
        return (message) => {
          if (target._sessionRequestGeneration !== sessionRequestGeneration) return
          target.postMessage({
            ...message,
            ...(proxyGenerationId === undefined ? {} : { proxyGenerationId }),
            ...(requestGenerationId === undefined ? {} : { requestGenerationId }),
          })
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

export function registerPortListener(executor) {
  Browser.runtime.onConnect.addListener((port) => {
    console.debug('connected')
    const onMessage = async (msg) => {
      console.debug('received msg', msg)
      if (msg.stop) {
        invalidateLatestPortSessionRequest(port)
        acknowledgePortStop(port, msg)
        return
      }
      const session = msg.session
      if (!session) return
      const isLatestSessionRequest = claimLatestPortSessionRequest(port)
      const requestPort = createSessionRequestPort(
        port,
        msg.proxyGenerationId,
        msg.requestGenerationId,
      )
      const config = await getUserConfig()
      if (!isLatestSessionRequest()) return
      const language =
        config.preferredLanguage === 'auto' ? config.userLanguage : config.preferredLanguage
      const translate = getFixedT(language)
      if (!session.modelName) session.modelName = config.modelName
      if (!session.apiMode && session.modelName !== 'customModel') session.apiMode = config.apiMode
      if (session.apiMode) session.apiMode = normalizeApiMode(session.apiMode)
      if (!session.aiName)
        session.aiName = modelNameToDesc(
          session.apiMode ? apiModeToModelName(session.apiMode) : session.modelName,
          translate,
          config.customModelName,
        )
      requestPort.postMessage({ session })
      try {
        await executor(
          session,
          requestPort,
          config,
          isLatestSessionRequest,
          msg.requestGenerationId,
          port,
        )
      } catch (err) {
        if (isLatestSessionRequest()) handlePortError(session, requestPort, err, translate)
      }
    }

    const onDisconnect = () => {
      console.debug('port disconnected, remove listener')
      port.onMessage.removeListener(onMessage)
      port.onDisconnect.removeListener(onDisconnect)
    }

    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(onDisconnect)
  })
}
