import PropTypes from 'prop-types'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatVideoOffset } from '../../video-summary/time.mjs'

const MESSAGE_KEYS = {
  MODEL_LOGIN_REQUIRED: 'Sign in to the selected AI provider, then retry the summary.',
  MODEL_PROVIDER_PAGE_REQUIRED: 'Open the selected AI provider page, then retry the summary.',
  MODEL_OUTPUT_INCOMPLETE:
    'The model response reached its output limit; available content was preserved.',
  VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE:
    'Some chapter or key-moment locations are unavailable.',
  YOUTUBE_VIDEO_UNAVAILABLE: 'This YouTube video is unavailable or restricted.',
  YOUTUBE_INVALID_VIDEO_ID: 'The YouTube video changed or could not be identified.',
  YOUTUBE_PLAYER_RESPONSE_UNAVAILABLE: 'YouTube video information could not be loaded.',
  YOUTUBE_SUBTITLES_NOT_FOUND: 'No usable YouTube subtitles were found.',
  YOUTUBE_SUBTITLE_REQUEST_FAILED: 'YouTube subtitles could not be loaded.',
  YOUTUBE_SUBTITLE_PARSE_FAILED: 'YouTube subtitles could not be read.',
  YOUTUBE_AUDIO_NOT_FOUND: 'No usable YouTube audio source was found.',
  VIDEO_MEDIA_SOURCE_EXPIRED: 'The video source expired. Refresh the page and try again.',
  MEDIAKIT_API_KEY_REQUIRED: 'Configure the MediaKit API key, then try again.',
  VIDEO_MEDIA_LOCAL_HEADERS_UNSUPPORTED:
    'Local media fallback is unavailable because this source requires unsupported request headers.',
  VIDEO_SUMMARY_SUBMISSION_UNKNOWN:
    'The transcription submission outcome is unknown and was not retried.',
}

function messageFor(code, t) {
  return t(MESSAGE_KEYS[code] || 'Video Summary Unknown Error')
}

function timestampLabel(startMs, endMs = null, unknownLabel = 'Unknown') {
  const start = formatVideoOffset(startMs) || unknownLabel
  return Number.isFinite(endMs) ? `${start} - ${formatVideoOffset(endMs) || unknownLabel}` : start
}

function SourceChoices({
  sourceChoice,
  subtitleTracks,
  selectedSubtitleTrackId,
  sourceActionsDisabled,
  onSelectSubtitleTrack,
  onChooseSource,
}) {
  const { t } = useTranslation()
  return (
    <div className="video-summary-view__choices">
      <label>
        <span>{t('Subtitle track')}</span>
        <select
          data-source-choice="native-subtitle"
          disabled={sourceActionsDisabled || subtitleTracks.length === 0}
          value={selectedSubtitleTrackId || ''}
          onChange={(event) => onSelectSubtitleTrack(event.currentTarget.value)}
        >
          {subtitleTracks.map((track) => (
            <option key={track.id} value={track.id}>
              {track.label} · {t(`Video Summary Source ${track.sourceKind}`)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        data-source-choice="native-subtitle"
        className={sourceChoice === 'native-subtitle' ? 'is-selected' : ''}
        disabled={sourceActionsDisabled || subtitleTracks.length === 0 || !selectedSubtitleTrackId}
        onClick={() => onChooseSource('native-subtitle')}
      >
        {t('Summarize subtitles')}
      </button>
      <button
        type="button"
        data-source-choice="asr"
        className={sourceChoice === 'asr' ? 'is-selected' : ''}
        disabled={sourceActionsDisabled}
        onClick={() => onChooseSource('asr')}
      >
        {t('Run ASR')}
      </button>
    </div>
  )
}

SourceChoices.propTypes = {
  sourceChoice: PropTypes.string,
  subtitleTracks: PropTypes.arrayOf(PropTypes.object).isRequired,
  selectedSubtitleTrackId: PropTypes.string,
  sourceActionsDisabled: PropTypes.bool.isRequired,
  onSelectSubtitleTrack: PropTypes.func.isRequired,
  onChooseSource: PropTypes.func.isRequired,
}

function AsrConfirmation({ disabled, onConfirmAsr, onCancelAsrConfirmation }) {
  const { t } = useTranslation()
  return (
    <div className="video-summary-view__confirm">
      <p>
        {t(
          'ASR uploads audio to a remote service. Confirm that you accept remote retention and the cancellation cost before continuing.',
        )}
      </p>
      <div className="video-summary-view__actions">
        <button type="button" data-action="confirm-asr" disabled={disabled} onClick={onConfirmAsr}>
          {t('Confirm ASR')}
        </button>
        <button type="button" data-action="cancel-asr" onClick={onCancelAsrConfirmation}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}

AsrConfirmation.propTypes = {
  disabled: PropTypes.bool.isRequired,
  onConfirmAsr: PropTypes.func.isRequired,
  onCancelAsrConfirmation: PropTypes.func.isRequired,
}

function Actions({
  canCancel,
  canRetrySummary,
  hasResult,
  hasTranscript,
  onArchive,
  onAskAboutVideo,
  onCancelTask,
  onDownloadMarkdown,
  onDownloadTranscript,
  onRetrySummary,
}) {
  const { t } = useTranslation()
  const cancelPendingRef = useRef(false)
  const [cancelPending, setCancelPending] = useState(false)
  return (
    <div className="video-summary-view__actions">
      {canCancel ? (
        <button
          type="button"
          data-action="cancel-task"
          disabled={cancelPending}
          onClick={() => {
            if (cancelPendingRef.current) return
            cancelPendingRef.current = true
            setCancelPending(true)
            onCancelTask()
          }}
        >
          {t(cancelPending ? 'Cancelling summary' : 'Cancel summary')}
        </button>
      ) : null}
      {canRetrySummary ? (
        <button type="button" data-action="retry-summary" onClick={onRetrySummary}>
          {t('Retry summary only')}
        </button>
      ) : null}
      <button type="button" data-action="archive" disabled={!hasResult} onClick={onArchive}>
        {t('Archive summary')}
      </button>
      <button
        type="button"
        data-action="ask-about-video"
        disabled={!hasResult}
        onClick={onAskAboutVideo}
      >
        {t('Ask about this video')}
      </button>
      <button
        type="button"
        data-action="download-transcript"
        disabled={!hasTranscript}
        onClick={onDownloadTranscript}
      >
        {t('Download transcript')}
      </button>
      <button
        type="button"
        data-action="download-markdown"
        disabled={!hasResult}
        onClick={onDownloadMarkdown}
      >
        {t('Download Markdown')}
      </button>
    </div>
  )
}

Actions.propTypes = {
  canCancel: PropTypes.bool.isRequired,
  canRetrySummary: PropTypes.bool.isRequired,
  hasResult: PropTypes.bool.isRequired,
  hasTranscript: PropTypes.bool.isRequired,
  onArchive: PropTypes.func.isRequired,
  onAskAboutVideo: PropTypes.func.isRequired,
  onCancelTask: PropTypes.func.isRequired,
  onDownloadMarkdown: PropTypes.func.isRequired,
  onDownloadTranscript: PropTypes.func.isRequired,
  onRetrySummary: PropTypes.func.isRequired,
}

function TimestampButton({ startMs, endMs = null, label, onSeekTo }) {
  const { t } = useTranslation()
  return (
    <button type="button" data-seek-ms={String(startMs)} onClick={() => onSeekTo(startMs)}>
      {label || timestampLabel(startMs, endMs, t('Unknown'))}
    </button>
  )
}

TimestampButton.propTypes = {
  startMs: PropTypes.number.isRequired,
  endMs: PropTypes.number,
  label: PropTypes.string,
  onSeekTo: PropTypes.func.isRequired,
}

export default function VideoSummaryView({
  platform,
  videoTitle,
  sourceChoice,
  subtitleTracks = [],
  selectedSubtitleTrackId,
  subtitleDiscoveryStatus,
  asrConfirmationVisible = false,
  sourceActionsDisabled = false,
  canCancel = false,
  canRetrySummary = false,
  taskState,
  onSelectSubtitleTrack,
  onChooseSource,
  onConfirmAsr,
  onCancelAsrConfirmation,
  onArchive,
  onAskAboutVideo,
  onDownloadMarkdown,
  onDownloadTranscript,
  onSeekTo,
  onCancelTask,
  onRetrySummary,
}) {
  const { t } = useTranslation()
  const [showAsrConfirmation, setShowAsrConfirmation] = useState(asrConfirmationVisible)
  const [summaryOpen, setSummaryOpen] = useState(true)

  useEffect(() => setShowAsrConfirmation(asrConfirmationVisible), [asrConfirmationVisible])
  useEffect(() => {
    if (taskState?.result) setSummaryOpen(true)
  }, [taskState?.result])

  const result = taskState?.result || null
  const warnings = Array.isArray(result?.warnings) ? result.warnings : []
  const keyPoints = Array.isArray(result?.keyPoints) ? result.keyPoints : []
  const chapters = Array.isArray(result?.chapters) ? result.chapters : []
  const keyMoments = Array.isArray(result?.keyMoments) ? result.keyMoments : []
  const resultTranscriptSegments = Array.isArray(result?.transcriptSegments)
    ? result.transcriptSegments
    : []
  const selectedSubtitleTrack = subtitleTracks.find((track) => track.id === selectedSubtitleTrackId)
  const selectedTrackSegments = Array.isArray(selectedSubtitleTrack?.cues)
    ? selectedSubtitleTrack.cues.filter(
        (cue) =>
          Number.isFinite(cue?.startMs) &&
          Number.isFinite(cue?.endMs) &&
          typeof cue?.text === 'string' &&
          cue.text.trim(),
      )
    : []
  const transcriptSegments =
    selectedTrackSegments.length > 0 ? selectedTrackSegments : resultTranscriptSegments
  const hasTranscript = transcriptSegments.length > 0

  return (
    <section className="video-summary-view" data-platform={platform}>
      <header className="video-summary-view__header">
        <h2>{videoTitle || t('Video summary')}</h2>
        <div className="video-summary-view__meta">
          <span>
            {t('Choice')}: {sourceChoice || t('None')}
          </span>
          <span>
            {t('Phase')}: {taskState?.phase || t('Idle')}
          </span>
          <span>
            {t('Status')}: {result?.status || t('Pending')}
          </span>
          <span>
            {t('Stage')}: {taskState?.activeStage || t('Idle')}
          </span>
        </div>
      </header>
      <SourceChoices
        sourceChoice={sourceChoice}
        subtitleTracks={subtitleTracks}
        selectedSubtitleTrackId={selectedSubtitleTrackId}
        sourceActionsDisabled={sourceActionsDisabled}
        onSelectSubtitleTrack={onSelectSubtitleTrack}
        onChooseSource={(choice) => {
          setShowAsrConfirmation(choice === 'asr')
          onChooseSource(choice)
        }}
      />
      {subtitleTracks.length === 0 && subtitleDiscoveryStatus === 'login-required' ? (
        <p className="video-summary-view__subtitle-notice">
          {t('Sign in to Bilibili to check for AI subtitles')}
        </p>
      ) : subtitleTracks.length === 0 ? (
        <p className="video-summary-view__subtitle-notice">{t('No video subtitles available')}</p>
      ) : null}
      {showAsrConfirmation ? (
        <AsrConfirmation
          disabled={sourceActionsDisabled}
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
      <Actions
        canCancel={canCancel}
        canRetrySummary={canRetrySummary}
        hasResult={Boolean(result)}
        hasTranscript={hasTranscript}
        onArchive={onArchive}
        onAskAboutVideo={onAskAboutVideo}
        onCancelTask={onCancelTask}
        onDownloadMarkdown={onDownloadMarkdown}
        onDownloadTranscript={onDownloadTranscript}
        onRetrySummary={onRetrySummary}
      />
      {taskState?.errorMessage ? (
        <p className="video-summary-view__error" role="alert">
          {messageFor(taskState.errorMessage, t)}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="video-summary-view__warnings">
          {warnings.map((warning) => (
            <li key={warning}>{messageFor(warning, t)}</li>
          ))}
        </ul>
      ) : null}
      {result ? (
        <details
          data-section="summary"
          open={summaryOpen}
          onToggle={(event) => setSummaryOpen(event.currentTarget.open)}
        >
          <summary>{t('Summary')}</summary>
          <div className="video-summary-view__summary-scroll">
            {result.overview || result.rawSummaryText ? (
              <p>{result.overview || result.rawSummaryText}</p>
            ) : null}
            {keyPoints.length > 0 ? (
              <details data-section="key-points">
                <summary>{t('Key points')}</summary>
                <ul>
                  {keyPoints.map((item) => (
                    <li key={`${item.point}-${item.startMs}`}>
                      {Number.isFinite(item.startMs) ? (
                        <TimestampButton startMs={item.startMs} onSeekTo={onSeekTo} />
                      ) : null}
                      <span>{item.point}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {chapters.length > 0 ? (
              <details data-section="chapters">
                <summary>{t('Chapters')}</summary>
                <ul>
                  {chapters.map((chapter) => (
                    <li key={`${chapter.title}-${chapter.startMs}`}>
                      {Number.isFinite(chapter.startMs) ? (
                        <TimestampButton
                          startMs={chapter.startMs}
                          endMs={chapter.endMs}
                          onSeekTo={onSeekTo}
                        />
                      ) : null}
                      <strong>{chapter.title}</strong>
                      <p>{chapter.summary}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {keyMoments.length > 0 ? (
              <details data-section="key-moments">
                <summary>{t('Key moments')}</summary>
                <ul>
                  {keyMoments.map((moment) => (
                    <li key={`${moment.point}-${moment.startMs}`}>
                      {Number.isFinite(moment.startMs) ? (
                        <TimestampButton
                          startMs={moment.startMs}
                          label={timestampLabel(moment.startMs, null, t('Unknown'))}
                          onSeekTo={onSeekTo}
                        />
                      ) : null}
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
        <summary>{t('Transcript')}</summary>
        <div className="video-summary-view__transcript-scroll">
          <ul>
            {transcriptSegments.map((segment) => (
              <li key={segment.id || `${segment.startMs}-${segment.endMs}`}>
                <TimestampButton
                  startMs={segment.startMs}
                  endMs={segment.endMs}
                  onSeekTo={onSeekTo}
                />
                <span>
                  {segment.speaker ? `${segment.speaker}: ` : ''}
                  {segment.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </section>
  )
}

VideoSummaryView.propTypes = {
  platform: PropTypes.oneOf(['bilibili', 'youtube']).isRequired,
  videoTitle: PropTypes.string,
  sourceChoice: PropTypes.string,
  subtitleTracks: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      language: PropTypes.string,
      sourceKind: PropTypes.oneOf(['author', 'automatic', 'bilibili-ai', 'ai', 'unknown'])
        .isRequired,
      cues: PropTypes.array.isRequired,
    }),
  ),
  selectedSubtitleTrackId: PropTypes.string,
  subtitleDiscoveryStatus: PropTypes.string,
  asrConfirmationVisible: PropTypes.bool,
  sourceActionsDisabled: PropTypes.bool,
  canCancel: PropTypes.bool,
  canRetrySummary: PropTypes.bool,
  taskState: PropTypes.object,
  onSelectSubtitleTrack: PropTypes.func.isRequired,
  onChooseSource: PropTypes.func.isRequired,
  onConfirmAsr: PropTypes.func.isRequired,
  onCancelAsrConfirmation: PropTypes.func.isRequired,
  onArchive: PropTypes.func.isRequired,
  onAskAboutVideo: PropTypes.func.isRequired,
  onDownloadMarkdown: PropTypes.func.isRequired,
  onDownloadTranscript: PropTypes.func.isRequired,
  onSeekTo: PropTypes.func.isRequired,
  onCancelTask: PropTypes.func.isRequired,
  onRetrySummary: PropTypes.func.isRequired,
}
