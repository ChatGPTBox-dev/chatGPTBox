import { getUserConfig } from './index.mjs'
import { languageList } from './language-data.mjs'

export { languageList }

export async function getUserLanguage() {
  const config = await getUserConfig()
  return languageList[config.userLanguage].name
}

export async function getUserLanguageNative() {
  const config = await getUserConfig()
  return languageList[config.userLanguage].native
}

export async function getPreferredLanguage() {
  const config = await getUserConfig()
  const language =
    config.preferredLanguage === 'auto' ? config.userLanguage : config.preferredLanguage
  return languageList[language].name
}

export async function getPreferredLanguageNative() {
  const config = await getUserConfig()
  const language =
    config.preferredLanguage === 'auto' ? config.userLanguage : config.preferredLanguage
  return languageList[language].native
}
