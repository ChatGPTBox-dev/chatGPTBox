import { useState } from 'react'
import { MuteIcon, UnmuteIcon } from '@primer/octicons-react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../../hooks/use-config.mjs'
import { findMatchingVoice, resolveSpeechLanguage } from './voice.mjs'

ReadButton.propTypes = {
  contentFn: PropTypes.func.isRequired,
  size: PropTypes.number.isRequired,
  className: PropTypes.string,
}

const synth = window.speechSynthesis

function ReadButton({ className, contentFn, size }) {
  const { t } = useTranslation()
  const [speaking, setSpeaking] = useState(false)
  const config = useConfig()

  const startSpeak = () => {
    synth.cancel()

    const text = contentFn()
    const utterance = new SpeechSynthesisUtterance(text)
    const voices = synth.getVoices()
    const preferredLanguage = resolveSpeechLanguage(config)

    let preferredVoiceName = ''
    if (preferredLanguage.includes('en') && navigator.language.includes('en'))
      preferredVoiceName = 'microsoft aria'
    else if (preferredLanguage.includes('zh') || navigator.language.includes('zh'))
      preferredVoiceName = 'xiaoyi'
    else if (preferredLanguage.includes('ja') || navigator.language.includes('ja'))
      preferredVoiceName = 'nanami'

    let voice = findMatchingVoice(voices, preferredLanguage, preferredVoiceName)
    if (!voice) voice = voices.find((v) => v.lang === navigator.language)

    Object.assign(utterance, {
      rate: 1,
      volume: 1,
      onend: () => setSpeaking(false),
      onerror: () => setSpeaking(false),
      voice: voice,
    })

    synth.speak(utterance)
    setSpeaking(true)
  }

  const stopSpeak = () => {
    synth.cancel()
    setSpeaking(false)
  }

  return (
    <span
      title={t('Read Aloud')}
      className={`gpt-util-icon ${className ? className : ''}`}
      onClick={speaking ? stopSpeak : startSpeak}
    >
      {speaking ? <MuteIcon size={size} /> : <UnmuteIcon size={size} />}
    </span>
  )
}

export default ReadButton
