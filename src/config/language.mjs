import { getPreferredLanguageKey, getUserConfig } from './index.mjs'
import { languageList } from './language-data.mjs'

export { languageList }

export function formatLanguageForPrompt(languageKey) {
  const { name, native } = languageList[languageKey]
  return native && native !== name
    ? `${name} (${native}; ${languageKey})`
    : `${name} (${languageKey})`
}

export async function getUserLanguage() {
  const config = await getUserConfig()
  return languageList[config.userLanguage].name
}

export async function getUserLanguageNative() {
  const config = await getUserConfig()
  return languageList[config.userLanguage].native
}

export async function getPreferredLanguage(config = null) {
  return formatLanguageForPrompt(await getPreferredLanguageKey(config))
}

export async function getPreferredLanguageNative() {
  const language = await getPreferredLanguageKey()
  return languageList[language].native
}
