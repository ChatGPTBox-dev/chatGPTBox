import { getUserConfig } from '../../config/index.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { generateAnswersWithOpenAICompatible } from './openai-compatible-core.mjs'

/**
 * Azure OpenAI wraps the same chat-completions payload as the other OpenAI-compatible
 * providers, so it only has to describe the deployment URL and the `api-key` header; the
 * shared core owns the request body and the stream parsing.
 *
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 */
export async function generateAnswersWithAzureOpenaiApi(port, question, session) {
  const config = await getUserConfig()
  const deploymentName = getModelValue(session) || config.azureDeploymentName
  const baseUrl = config.azureEndpoint.replace(/\/$/, '')

  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: 'chat',
    requestUrl: `${baseUrl}/openai/deployments/${deploymentName}/chat/completions?api-version=2024-02-01`,
    // The deployment is in the URL and the key rides in a header, so no model and no bearer
    // token are sent. The empty model also keeps the temperature allow-list from treating an
    // opaque deployment alias as a canonical model id.
    model: '',
    apiKey: '',
    config,
    extraHeaders: { 'api-key': config.azureApiKey },
  })
}
