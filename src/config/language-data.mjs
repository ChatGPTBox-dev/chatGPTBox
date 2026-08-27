import countriesList from 'countries-list'

const { languages } = countriesList
const FALLBACK_LANGUAGE = 'en'
const { zh, ...baseLanguages } = languages

export const languageList = {
  auto: { name: 'Auto', native: 'Auto' },
  ...baseLanguages,
  'zh-Hans': {
    ...zh,
    name: 'Chinese (Simplified)',
    native: '简体中文',
  },
  'zh-Hant': {
    ...zh,
    name: 'Chinese (Traditional)',
    native: '正體中文',
  },
}

export function isValidLanguageKey(key) {
  return typeof key === 'string' && Object.hasOwn(languageList, key)
}

export function resolveLanguageKey(locale) {
  if (typeof locale !== 'string') return FALLBACK_LANGUAGE
  const normalizedLocale = locale.trim()
  if (!normalizedLocale) return FALLBACK_LANGUAGE
  const lowerLocale = normalizedLocale.toLowerCase()
  if (lowerLocale === 'zh-cht') return 'zh-Hant'
  if (lowerLocale === 'zh-chs') return 'zh-Hans'

  try {
    const parsedLocale = new Intl.Locale(normalizedLocale)
    if (parsedLocale.language === 'zh') {
      return parsedLocale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans'
    }
    return isValidLanguageKey(parsedLocale.language) ? parsedLocale.language : FALLBACK_LANGUAGE
  } catch {
    return FALLBACK_LANGUAGE
  }
}

export function resolvePreferredLanguageKey(preferredLanguage, userLanguage) {
  return isValidLanguageKey(preferredLanguage) ? preferredLanguage : userLanguage
}

export function getNavigatorLanguage() {
  return resolveLanguageKey(navigator.language)
}
