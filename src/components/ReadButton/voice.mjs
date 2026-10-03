function parseLanguageTag(languageTag) {
  if (typeof languageTag !== 'string') return null
  const normalizedLanguageTag = languageTag.trim()
  if (!normalizedLanguageTag) return null
  try {
    const locale = new Intl.Locale(normalizedLanguageTag)
    const maximizedLocale = locale.maximize()
    return {
      language: locale.language,
      script: maximizedLocale.script,
    }
  } catch {
    return null
  }
}

function findPreferredVoice(voices, preferredVoiceName) {
  if (typeof preferredVoiceName !== 'string') return undefined
  const normalizedPreferredVoiceName = preferredVoiceName.trim().toLowerCase()
  if (!normalizedPreferredVoiceName) return undefined
  return voices.find((voice) => voice.name.toLowerCase().includes(normalizedPreferredVoiceName))
}

export function resolveSpeechLanguage(config) {
  return config.preferredLanguage === 'auto' ? config.userLanguage : config.preferredLanguage
}

export function findMatchingVoice(voices, targetLanguage, preferredVoiceName = '') {
  const target = parseLanguageTag(targetLanguage)
  if (!target) return undefined

  const parsedVoices = voices
    .map((voice) => ({ voice, language: parseLanguageTag(voice.lang) }))
    .filter(({ language }) => language)
  const scriptMatches = parsedVoices.filter(
    ({ language }) => language.language === target.language && language.script === target.script,
  )
  const preferredScriptMatch = findPreferredVoice(
    scriptMatches.map(({ voice }) => voice),
    preferredVoiceName,
  )
  if (preferredScriptMatch) return preferredScriptMatch
  if (scriptMatches.length > 0) return scriptMatches[0].voice

  const languageMatches = parsedVoices
    .filter(({ language }) => language.language === target.language)
    .map(({ voice }) => voice)
  return findPreferredVoice(languageMatches, preferredVoiceName) || languageMatches[0]
}
