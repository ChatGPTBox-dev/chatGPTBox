/**
 * OpenAI Text-to-Speech service
 */

import { getUserConfig } from '../config/index.mjs'

/**
 * Available OpenAI TTS voices
 */
export const TTS_VOICES = {
  alloy: 'Alloy',
  echo: 'Echo',
  fable: 'Fable',
  onyx: 'Onyx',
  nova: 'Nova',
  shimmer: 'Shimmer',
}

/**
 * Available OpenAI TTS models
 */
export const TTS_MODELS = {
  'tts-1': 'TTS-1 (Standard)',
  'tts-1-hd': 'TTS-1-HD (High Quality)',
}

/**
 * Generate speech using OpenAI TTS API
 * @param {string} text - Text to convert to speech
 * @param {Object} options - TTS options
 * @returns {Promise<Blob>} Audio blob
 */
export async function generateSpeech(text, options = {}) {
  const config = await getUserConfig()

  if (!config.apiKey) {
    throw new Error('OpenAI API key is required for TTS functionality')
  }

  const {
    voice = config.openAiTtsVoice || 'alloy',
    model = config.openAiTtsModel || 'tts-1',
    speed = config.openAiTtsSpeed || 1.0,
  } = options

  const response = await fetch(`${config.customOpenAiApiUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      speed: Math.max(0.25, Math.min(4.0, speed)), // Clamp speed between 0.25 and 4.0
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI TTS API error: ${response.status} ${errorText}`)
  }

  return await response.blob()
}

/**
 * Play audio from blob with proper cleanup
 * @param {Blob} audioBlob - Audio blob to play
 * @returns {Promise<HTMLAudioElement>} Audio element promise that resolves when playback starts
 */
export function playAudioBlob(audioBlob) {
  return new Promise((resolve, reject) => {
    const audioUrl = URL.createObjectURL(audioBlob)
    const audio = new Audio(audioUrl)

    // Clean up the object URL when audio ends or errors
    const cleanup = () => {
      URL.revokeObjectURL(audioUrl)
    }

    audio.onended = cleanup
    audio.onerror = (error) => {
      cleanup()
      reject(error)
    }

    audio.oncanplaythrough = () => {
      resolve(audio)
    }

    audio.load()
  })
}

/**
 * Generate and play speech using OpenAI TTS
 * @param {string} text - Text to speak
 * @param {Object} options - TTS options
 * @returns {Promise<HTMLAudioElement>} Audio element
 */
export async function speakText(text, options = {}) {
  const audioBlob = await generateSpeech(text, options)
  return await playAudioBlob(audioBlob)
}

/**
 * Check if OpenAI TTS is available and properly configured
 * @returns {Promise<boolean>}
 */
export async function isTtsAvailable() {
  try {
    const config = await getUserConfig()
    return config.enableOpenAiTts && !!config.apiKey
  } catch (error) {
    return false
  }
}
