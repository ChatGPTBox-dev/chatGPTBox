import { OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID } from '../../config/openai-provider-mappings.mjs'

/**
 * API modes probed through their own protocol rather than the OpenAI-compatible path.
 */
export const NATIVE_CONNECTION_TEST_GROUPS = ['azureOpenAiApiModelKeys', 'claudeApiModelKeys']

/**
 * Modes the Test action can actually exercise. Browser/cookie modes and the
 * third-party relay have no request shape we can send, so their rows stay untestable.
 */
export const CONNECTION_TESTABLE_GROUPS = new Set([
  ...Object.keys(OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID),
  ...NATIVE_CONNECTION_TEST_GROUPS,
])

/**
 * @param {{apiMode?: object, modelName?: string}} session
 * @returns {boolean} whether a connection test can be run for this session
 */
export function canTestConnectionSession(session) {
  const groupName = session?.apiMode?.groupName
  if (groupName) return CONNECTION_TESTABLE_GROUPS.has(groupName)
  // The custom model on the General tab has no API mode of its own.
  return session?.modelName === 'customModel'
}
