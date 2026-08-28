import {
  getApiModesFromConfig,
  getModelValue,
  isApiModeSelected,
} from '../utils/model-name-convert.mjs'
import { resolveOpenAICompatibleRequest } from './apis/provider-registry.mjs'

export function isConversationTitleModelAvailable(
  config,
  resolveRequest = resolveOpenAICompatibleRequest,
) {
  const apiMode = config?.conversationTitleApiMode
  if (!apiMode || typeof apiMode !== 'object') return false
  const isEnabled = getApiModesFromConfig(config, true).some((candidate) =>
    isApiModeSelected(candidate, { apiMode }, { sessionCompat: true }),
  )
  if (!isEnabled || !getModelValue({ apiMode })) return false
  const request = resolveRequest(config, { apiMode })
  return Boolean(request && request.endpointType === 'chat' && request.requestUrl)
}
