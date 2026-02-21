import { useState, useEffect } from 'react'
import { MuteIcon, UnmuteIcon } from '@primer/octicons-react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../../hooks/use-config.mjs'
import { speakText, isTtsAvailable } from '../../services/openai-tts.mjs'

ReadButton.propTypes = {
  contentFn: PropTypes.func.isRequired,
  size: PropTypes.number.isRequired,
  className: PropTypes.string,
}

const synth = window.speechSynthesis

function ReadButton({ className, contentFn, size }) {
  const { t } = useTranslation()
  const [speaking, setSpeaking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [useOpenAiTts, setUseOpenAiTts] = useState(false)
  const [currentAudio, setCurrentAudio] = useState(null)
  const config = useConfig()

  // Check if OpenAI TTS is available on component mount and config changes
  useEffect(() => {
    const checkTtsAvailability = async () => {
      const available = await isTtsAvailable()
      setUseOpenAiTts(available)
    }
    checkTtsAvailability()
  }, [config.enableOpenAiTts, config.apiKey])

  const startOpenAiTtsSpeak = async () => {
    try {
      setLoading(true)
      setSpeaking(true)

      const text = contentFn()
      const audio = await speakText(text, {
        voice: config.openAiTtsVoice,
        model: config.openAiTtsModel,
        speed: config.openAiTtsSpeed,
      })

      setCurrentAudio(audio)
      setLoading(false)

      // Play the audio
      await audio.play()

      // Handle audio end
      audio.onended = () => {
        setSpeaking(false)
        setCurrentAudio(null)
      }

      audio.onerror = () => {
        setSpeaking(false)
        setCurrentAudio(null)
        setLoading(false)
        console.error('Audio playback error')
      }
    } catch (error) {
      console.error('OpenAI TTS error:', error)
      setLoading(false)
      setSpeaking(false)
      setCurrentAudio(null)

      // Fallback to system TTS on error
      startSystemTtsSpeak()
    }
  }

  const startSystemTtsSpeak = () => {
    synth.cancel()

    const text = contentFn()
    const utterance = new SpeechSynthesisUtterance(text)
    const voices = synth.getVoices()

    let voice
    if (config.preferredLanguage.includes('en') && navigator.language.includes('en'))
      voice = voices.find((v) => v.name.toLowerCase().includes('microsoft aria'))
    else if (config.preferredLanguage.includes('zh') || navigator.language.includes('zh'))
      voice = voices.find((v) => v.name.toLowerCase().includes('xiaoyi'))
    else if (config.preferredLanguage.includes('ja') || navigator.language.includes('ja'))
      voice = voices.find((v) => v.name.toLowerCase().includes('nanami'))
    if (!voice) voice = voices.find((v) => v.lang.substring(0, 2) === config.preferredLanguage)
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

  const startSpeak = () => {
    if (useOpenAiTts) {
      startOpenAiTtsSpeak()
    } else {
      startSystemTtsSpeak()
    }
  }

  const stopSpeak = () => {
    if (currentAudio) {
      currentAudio.pause()
      currentAudio.currentTime = 0
      setCurrentAudio(null)
    }
    synth.cancel()
    setSpeaking(false)
    setLoading(false)
  }

  // Show loading state or speaking state
  const isActive = speaking || loading

  return (
    <span
      title={t('Read Aloud')}
      className={`gpt-util-icon ${className ? className : ''} ${loading ? 'loading' : ''}`}
      onClick={isActive ? stopSpeak : startSpeak}
      style={{ opacity: loading ? 0.6 : 1 }}
    >
      {isActive ? <MuteIcon size={size} /> : <UnmuteIcon size={size} />}
    </span>
  )
}

export default ReadButton
