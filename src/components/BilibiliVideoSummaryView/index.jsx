import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatVideoOffset } from '../../video-summary/time.mjs'

function renderTimestampLabel(startMs, endMs = null) {
  const startLabel = formatVideoOffset(startMs) || 'Unknown'
  if (!Number.isFinite(endMs)) return startLabel
  return `${startLabel} - ${formatVideoOffset(endMs) || 'Unknown'}`
}

function SourceChoiceButtons({ sourceChoice, subtitleTrack, onChooseSource }) {
  const { t } = useTranslation()
  const subtitleLabel =
    subtitleTrack?.sourceKind === 'author'
      ? t('Use author subtitles')
      : subtitleTrack?.sourceKind === 'bilibili-ai'
      ? t('Use Bilibili AI subtitles')
      : subtitleTrack?.label
      ? t('Use Bilibili subtitles: {{label}}', { label: subtitleTrack.label })
      : t('Bilibili subtitles unavailable')

  return (
    <div className="bilibili-video-summary-view__choices">
      <button
        type="button"
        data-source-choice="native-subtitle"
        disabled={!subtitleTrack}
        className={sourceChoice === 'native-subtitle' ? 'is-selected' : ''}
        onClick={() => onChooseSource('native-subtitle')}
      >
        {subtitleLabel}
        {subtitleTrack ? (
          <span className="bilibili-video-summary-view__recommended">{t('Recommended')}</span>
        ) : null}
      </button>
      <button
        type="button"
        data-source-choice="asr"
        className={sourceChoice === 'asr' ? 'is-selected' : ''}
        onClick={() => onChooseSource('asr')}
      >
        {t('Run ASR')}
      </button>
    </div>
  )
}

SourceChoiceButtons.propTypes = {
  sourceChoice: PropTypes.string,
  subtitleTrack: PropTypes.shape({
    id: PropTypes.string.isRequired,
    label: PropTypes.string,
    sourceKind: PropTypes.oneOf(['author', 'bilibili-ai', 'unknown']).isRequired,
    cues: PropTypes.array.isRequired,
  }),
  onChooseSource: PropTypes.func.isRequired,
}

function AsrConfirmation({ onConfirmAsr, onCancelAsrConfirmation }) {
  return (
    <div className="bilibili-video-summary-view__confirm">
      <p>
        ASR uploads audio to a remote service. Confirm that you accept remote retention and the
        cancellation cost before continuing.
      </p>
      <div className="bilibili-video-summary-view__actions">
        <button type="button" data-action="confirm-asr" onClick={onConfirmAsr}>
          Confirm ASR
        </button>
        <button type="button" data-action="cancel-asr" onClick={onCancelAsrConfirmation}>
          Cancel
        </button>
      </div>
    </div>
  )
}

AsrConfirmation.propTypes = {
  onConfirmAsr: PropTypes.func.isRequired,
  onCancelAsrConfirmation: PropTypes.func.isRequired,
}

function SummaryActions({
  canRetrySummary,
  hasResult,
  onArchive,
  onAskAboutVideo,
  onDownloadMarkdown,
  onRetrySummary,
}) {
  return (
    <div className="bilibili-video-summary-view__actions">
      {canRetrySummary ? (
        <button type="button" data-action="retry-summary" onClick={onRetrySummary}>
          Retry summary only
        </button>
      ) : null}
      <button type="button" data-action="archive" disabled={!hasResult} onClick={onArchive}>
        Archive summary
      </button>
      <button
        type="button"
        data-action="ask-about-video"
        disabled={!hasResult}
        onClick={onAskAboutVideo}
      >
        Ask about this video
      </button>
      <button
        type="button"
        data-action="download-markdown"
        disabled={!hasResult}
        onClick={onDownloadMarkdown}
      >
        Download Markdown
      </button>
    </div>
  )
}

SummaryActions.propTypes = {
  canRetrySummary: PropTypes.bool.isRequired,
  hasResult: PropTypes.bool.isRequired,
  onArchive: PropTypes.func.isRequired,
  onAskAboutVideo: PropTypes.func.isRequired,
  onDownloadMarkdown: PropTypes.func.isRequired,
  onRetrySummary: PropTypes.func.isRequired,
}

function TimestampButton({ startMs, endMs = null, label, onSeekTo }) {
  return (
    <button type="button" data-seek-ms={String(startMs)} onClick={() => onSeekTo(startMs)}>
      {label || renderTimestampLabel(startMs, endMs)}
    </button>
  )
}

TimestampButton.propTypes = {
  startMs: PropTypes.number.isRequired,
  endMs: PropTypes.number,
  label: PropTypes.string,
  onSeekTo: PropTypes.func.isRequired,
}

export default function BilibiliVideoSummaryView({
  videoTitle,
  sourceChoice,
  subtitleTrack,
  subtitleDiscoveryStatus,
  asrConfirmationVisible = false,
  taskState,
  onChooseSource,
  onConfirmAsr,
  onCancelAsrConfirmation,
  onArchive,
  onAskAboutVideo,
  onDownloadMarkdown,
  onSeekTo,
  onRetrySummary,
}) {
  const { t } = useTranslation()
  const [showAsrConfirmation, setShowAsrConfirmation] = useState(asrConfirmationVisible)
  const [summaryOpen, setSummaryOpen] = useState(true)

  useEffect(() => {
    setShowAsrConfirmation(asrConfirmationVisible)
  }, [asrConfirmationVisible])

  useEffect(() => {
    if (taskState?.result) setSummaryOpen(true)
  }, [taskState?.result])

  const result = taskState?.result || null
  const warnings = Array.isArray(result?.warnings) ? result.warnings : []
  const keyPoints = Array.isArray(result?.keyPoints) ? result.keyPoints : []
  const keyMoments = Array.isArray(result?.keyMoments) ? result.keyMoments : []
  const chapters = Array.isArray(result?.chapters) ? result.chapters : []
  const transcriptSegments = Array.isArray(result?.transcriptSegments)
    ? result.transcriptSegments
    : []
  const canRetrySummary = Boolean(taskState?.checkpointAvailable && result)

  return (
    <section className="bilibili-video-summary-view">
      <header className="bilibili-video-summary-view__header">
        <h2>{videoTitle || 'Bilibili video summary'}</h2>
        <div className="bilibili-video-summary-view__meta">
          <span>choice: {sourceChoice || 'none'}</span>
          <span>phase: {taskState?.phase || 'idle'}</span>
          <span>status: {result?.status || 'pending'}</span>
          <span>stage: {taskState?.activeStage || 'idle'}</span>
        </div>
      </header>

      <SourceChoiceButtons
        sourceChoice={sourceChoice}
        subtitleTrack={subtitleTrack}
        onChooseSource={(choice) => {
          setShowAsrConfirmation(choice === 'asr')
          onChooseSource(choice)
        }}
      />

      {!subtitleTrack && subtitleDiscoveryStatus === 'login-required' ? (
        <p className="bilibili-video-summary-view__subtitle-notice">
          {t('Sign in to Bilibili to check for AI subtitles')}
        </p>
      ) : !subtitleTrack ? (
        <p className="bilibili-video-summary-view__subtitle-notice">
          {t('No Bilibili subtitles available')}
        </p>
      ) : null}

      {showAsrConfirmation ? (
        <AsrConfirmation
          onConfirmAsr={() => {
            setShowAsrConfirmation(false)
            onConfirmAsr()
          }}
          onCancelAsrConfirmation={() => {
            setShowAsrConfirmation(false)
            onCancelAsrConfirmation()
          }}
        />
      ) : null}

      <SummaryActions
        canRetrySummary={canRetrySummary}
        hasResult={Boolean(result)}
        onArchive={onArchive}
        onAskAboutVideo={onAskAboutVideo}
        onDownloadMarkdown={onDownloadMarkdown}
        onRetrySummary={onRetrySummary}
      />

      {taskState?.errorMessage ? (
        <p className="bilibili-video-summary-view__error" role="alert">
          {taskState.errorMessage}
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="bilibili-video-summary-view__warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {result ? (
        <details
          data-section="summary"
          open={summaryOpen}
          onToggle={(event) => setSummaryOpen(event.currentTarget.open)}
        >
          <summary>Summary</summary>
          <div className="bilibili-video-summary-view__summary-scroll">
            {result.overview ? <p>{result.overview}</p> : null}

            {keyPoints.length > 0 ? (
              <details data-section="key-points">
                <summary>Key points</summary>
                <ul>
                  {keyPoints.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            {chapters.length > 0 ? (
              <details data-section="chapters">
                <summary>Chapters</summary>
                <ul>
                  {chapters.map((chapter) => (
                    <li key={`${chapter.title}-${chapter.startMs}`}>
                      <TimestampButton
                        startMs={chapter.startMs}
                        endMs={chapter.endMs}
                        onSeekTo={onSeekTo}
                      />
                      <strong>{chapter.title}</strong>
                      <p>{chapter.summary}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {keyMoments.length > 0 ? (
              <details data-section="key-moments">
                <summary>Key moments</summary>
                <ul>
                  {keyMoments.map((moment) => (
                    <li key={`${moment.point}-${moment.startMs}`}>
                      <TimestampButton
                        startMs={moment.startMs}
                        label={renderTimestampLabel(moment.startMs)}
                        onSeekTo={onSeekTo}
                      />
                      <span>{moment.point}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </details>
      ) : null}

      <details data-section="transcript">
        <summary>Transcript</summary>
        <div className="bilibili-video-summary-view__transcript-scroll">
          <ul>
            {transcriptSegments.map((segment) => {
              const speaker = segment.speaker ? `${segment.speaker}: ` : ''
              return (
                <li key={segment.id || `${segment.startMs}-${segment.endMs}`}>
                  <TimestampButton
                    startMs={segment.startMs}
                    endMs={segment.endMs}
                    onSeekTo={onSeekTo}
                  />
                  <span>
                    {speaker}
                    {segment.text}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </details>
    </section>
  )
}

BilibiliVideoSummaryView.propTypes = {
  videoTitle: PropTypes.string,
  sourceChoice: PropTypes.string,
  subtitleTrack: PropTypes.shape({
    id: PropTypes.string.isRequired,
    label: PropTypes.string,
    sourceKind: PropTypes.oneOf(['author', 'bilibili-ai', 'unknown']).isRequired,
    cues: PropTypes.array.isRequired,
  }),
  subtitleDiscoveryStatus: PropTypes.oneOf([
    'not-needed',
    'available',
    'not-found',
    'login-required',
    'unavailable',
  ]),
  asrConfirmationVisible: PropTypes.bool,
  taskState: PropTypes.shape({
    phase: PropTypes.string,
    activeStage: PropTypes.string,
    checkpointAvailable: PropTypes.bool,
    result: PropTypes.object,
    errorMessage: PropTypes.string,
  }),
  onChooseSource: PropTypes.func.isRequired,
  onConfirmAsr: PropTypes.func.isRequired,
  onCancelAsrConfirmation: PropTypes.func.isRequired,
  onArchive: PropTypes.func.isRequired,
  onAskAboutVideo: PropTypes.func.isRequired,
  onDownloadMarkdown: PropTypes.func.isRequired,
  onSeekTo: PropTypes.func.isRequired,
  onRetrySummary: PropTypes.func.isRequired,
}
