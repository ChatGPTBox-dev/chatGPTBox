import PropTypes from 'prop-types'
import { useEffect, useMemo, useState } from 'react'
import Browser from 'webextension-polyfill'
import { useTranslation } from 'react-i18next'
import {
  isVideoSummaryBuildEnabled,
  isVideoSummaryRuntimeSupported,
} from '../../video-summary/capabilities.mjs'
import {
  MAX_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS,
  MIN_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS,
  normalizeVideoSummaryMaxOutputTokens,
} from '../../video-summary/settings.mjs'

export function buildExportCredentialWarningMessage() {
  return 'Exporting all data writes plaintext API credentials to disk, including the MediaKit API key.'
}

export function getVideoSummaryEnabledUpdate(enabled) {
  return { videoTranscriptionEnabled: enabled }
}

function resolveVideoSummaryRuntimeSupport() {
  if (!isVideoSummaryBuildEnabled()) return false

  try {
    const manifest = Browser?.runtime?.getManifest?.() ?? {}
    return isVideoSummaryRuntimeSupported({
      manifestVersion: manifest.manifest_version,
      hasOffscreenPermission: manifest.permissions?.includes('offscreen') === true,
      minChromeVersion: manifest.minimum_chrome_version,
      userAgent: globalThis.navigator?.userAgent,
    })
  } catch (error) {
    console.warn('[popup] Failed to resolve video summary runtime support:', error)
    return false
  }
}

VideoSummarySettings.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

export function VideoSummarySettings({ config, updateConfig }) {
  const { t } = useTranslation()
  const runtimeSupported = useMemo(() => resolveVideoSummaryRuntimeSupport(), [])
  const [keyDraft, setKeyDraft] = useState('')
  const [keyState, setKeyState] = useState({ present: false })
  const [isKeyStateLoading, setIsKeyStateLoading] = useState(false)
  const [isKeyActionPending, setIsKeyActionPending] = useState(false)

  useEffect(() => {
    if (!runtimeSupported) return

    let cancelled = false
    const loadState = async () => {
      setIsKeyStateLoading(true)
      try {
        const response = await Browser.runtime.sendMessage({
          type: 'VIDEO_SUMMARY_MEDIAKIT_KEY_STATE',
        })
        if (!cancelled && response && typeof response.present === 'boolean') {
          setKeyState({ present: response.present })
        }
      } catch (error) {
        console.warn('[popup] Failed to load MediaKit key state:', error)
      } finally {
        if (!cancelled) setIsKeyStateLoading(false)
      }
    }

    void loadState()
    return () => {
      cancelled = true
    }
  }, [runtimeSupported])

  if (!runtimeSupported) return null

  const normalizedDraft = String(keyDraft || '').trim()
  const hasDraft = normalizedDraft.length > 0

  const setMediaKitKey = async () => {
    if (!hasDraft) return
    setIsKeyActionPending(true)
    try {
      const response = await Browser.runtime.sendMessage({
        type: 'VIDEO_SUMMARY_SET_MEDIAKIT_KEY',
        data: { apiKey: normalizedDraft },
      })
      if (response && typeof response.present === 'boolean') {
        setKeyState({ present: response.present })
      } else {
        setKeyState({ present: true })
      }
      setKeyDraft('')
    } finally {
      setIsKeyActionPending(false)
    }
  }

  const deleteMediaKitKey = async () => {
    setIsKeyActionPending(true)
    try {
      const response = await Browser.runtime.sendMessage({
        type: 'VIDEO_SUMMARY_DELETE_MEDIAKIT_KEY',
      })
      if (response && typeof response.present === 'boolean') {
        setKeyState({ present: response.present })
      } else {
        setKeyState({ present: false })
      }
    } finally {
      setIsKeyActionPending(false)
    }
  }

  const keyStatusLabel = isKeyStateLoading
    ? t('Loading...')
    : keyState.present
    ? t('Configured (masked)')
    : t('Not configured')

  return (
    <div className="popup-section">
      <h3>{t('Video summary')}</h3>
      <label>
        <input
          type="checkbox"
          checked={config.videoTranscriptionEnabled}
          onChange={(event) => updateConfig(getVideoSummaryEnabledUpdate(event.target.checked))}
        />
        {t('Enable video summary transcription for Bilibili and YouTube (Chromium only)')}
      </label>

      {config.videoTranscriptionEnabled ? (
        <div style={{ paddingLeft: 18 }}>
          <label>
            <input
              type="checkbox"
              checked={config.bilibiliSpeakerIdentificationEnabled !== false}
              onChange={(event) =>
                updateConfig({
                  bilibiliSpeakerIdentificationEnabled: event.target.checked,
                })
              }
            />
            {t('Enable speaker identification for ASR')}
          </label>

          <label>
            {t('Video summary max output tokens') +
              `: ${normalizeVideoSummaryMaxOutputTokens(config.bilibiliSummaryMaxOutputTokens)}`}
            <input
              type="number"
              min={MIN_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS}
              max={MAX_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS}
              step="1000"
              value={normalizeVideoSummaryMaxOutputTokens(config.bilibiliSummaryMaxOutputTokens)}
              onChange={(event) =>
                updateConfig({
                  bilibiliSummaryMaxOutputTokens: normalizeVideoSummaryMaxOutputTokens(
                    event.target.value,
                  ),
                })
              }
            />
          </label>
          <small>
            {t('This budget is shared by model reasoning and the final summary output.')}
          </small>

          <p style={{ marginTop: 6, marginBottom: 10 }}>
            {t(
              'ASR uploads audio to a remote service. You will be asked to confirm remote retention and the cancellation cost each time you run ASR.',
            )}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div>
              <strong>{t('MediaKit API key')}</strong>: {keyStatusLabel}{' '}
              {keyState.present ? <span aria-label="masked-key">••••••••</span> : null}
            </div>

            <input
              type="password"
              value={keyDraft}
              placeholder={t('Enter MediaKit API key')}
              onChange={(event) => setKeyDraft(event.target.value)}
              autoComplete="off"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="secondary"
                disabled={!hasDraft || isKeyActionPending}
                onClick={() => void setMediaKitKey()}
              >
                {keyState.present ? t('Replace API key') : t('Set API key')}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!keyState.present || isKeyActionPending}
                onClick={() => void deleteMediaKitKey()}
              >
                {t('Delete API key')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
