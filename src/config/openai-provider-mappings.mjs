export const LEGACY_API_KEY_FIELD_BY_PROVIDER_ID = {
  openai: 'apiKey',
  deepseek: 'deepSeekApiKey',
  moonshot: 'moonshotApiKey',
  mistral: 'mistralApiKey',
  openrouter: 'openRouterApiKey',
  aiml: 'aimlApiKey',
  chatglm: 'chatglmApiKey',
  ollama: 'ollamaApiKey',
  google: 'googleApiKey',
  'legacy-custom-default': 'customApiKey',
}

export const LEGACY_SECRET_KEY_TO_PROVIDER_ID = Object.fromEntries(
  Object.entries(LEGACY_API_KEY_FIELD_BY_PROVIDER_ID).map(([providerId, legacyKey]) => [
    legacyKey,
    providerId,
  ]),
)

export const OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID = {
  chatgptApiModelKeys: 'openai',
  gptApiModelKeys: 'openai',
  moonshotApiModelKeys: 'moonshot',
  mistralApiModelKeys: 'mistral',
  deepSeekApiModelKeys: 'deepseek',
  openRouterApiModelKeys: 'openrouter',
  aimlModelKeys: 'aiml',
  aimlApiModelKeys: 'aiml',
  chatglmApiModelKeys: 'chatglm',
  ollamaApiModelKeys: 'ollama',
  googleApiModelKeys: 'google',
  customApiModelKeys: 'legacy-custom-default',
}
