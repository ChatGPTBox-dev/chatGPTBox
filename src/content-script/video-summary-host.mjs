import { h, render } from 'preact'
import Browser from 'webextension-polyfill'
import FileSaver from 'file-saver'
import FloatingToolbar from '../components/FloatingToolbar'
import VideoSummaryView from '../components/VideoSummaryView/index.jsx'
import '../components/VideoSummaryView/styles.scss'
import { buildVideoSummaryMarkdown } from '../video-summary/markdown-export.mjs'
import { createVideoSummarySettingsSnapshot } from '../video-summary/settings.mjs'
import { selectPreferredSubtitleTrack } from '../video-summary/subtitle-tracks.mjs'
import { pageIdentitiesEqual } from '../video-summary/protocol.mjs'
import { createElementAtPosition } from '../utils'
import { createSession, initDefaultSession } from '../services/local-session.mjs'
import { getPreferredLanguageKey, getUserConfig } from '../config/index.mjs'
import { createVideoSummaryPortClient } from './video-summary-port.mjs'
import { createVideoSummaryHostWidthController } from './video-summary-host-width.mjs'

const PLATFORM_METADATA = Object.freeze({
  bilibili: Object.freeze({ productName: 'Bilibili', fileNameFallback: 'bilibili-summary' }),
  youtube: Object.freeze({ productName: 'YouTube', fileNameFallback: 'youtube-video-summary' }),
})
const TASK_BY_PAGE = new Map()

function createPageKey(pageIdentity) {
  return `${pageIdentity.platform}:${pageIdentity.mediaId}`
}

function sanitizeFileName(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .toLowerCase()
}

function formatTranscriptTimestamp(value) {
  const milliseconds = Math.max(0, Math.trunc(Number(value) || 0))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1000)
  const remainder = milliseconds % 1000
  return (
    [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':') +
    `.${String(remainder).padStart(3, '0')}`
  )
}

function buildTranscriptText(segments) {
  return segments
    .map((segment) => {
      const range = `${formatTranscriptTimestamp(segment.startMs)} - ${formatTranscriptTimestamp(
        segment.endMs,
      )}`
      const speaker = segment.speaker ? `${String(segment.speaker).trim()}: ` : ''
      const text = String(segment.text || '')
        .replace(/\s+/g, ' ')
        .trim()
      return `[${range}] ${speaker}${text}`.trimEnd()
    })
    .join('\n')
}

function buildAskPrompt({ title, result }) {
  const chapterLines = (Array.isArray(result?.chapters) ? result.chapters : [])
    .map((chapter) => `- ${chapter.title}: ${chapter.summary || ''}`.trim())
    .join('\n')
  return [
    `Use only the structured video summary below when answering questions about "${
      title || 'this video'
    }".`,
    '',
    `Overview: ${result?.overview || 'Unavailable'}`,
    '',
    'Key content:',
    ...(Array.isArray(result?.keyMoments) ? result.keyMoments : []).map(
      (item) => `- ${String(item?.point || '').trim()}`,
    ),
    '',
    'Chapter summaries:',
    chapterLines || '- None',
  ].join('\n')
}

function createToolbarLauncher() {
  let toolbarContainer = null
  return {
    async open(prompt, isCurrent = () => true) {
      const session = await initDefaultSession()
      if (!isCurrent()) return
      if (toolbarContainer?.isConnected) {
        render(null, toolbarContainer)
        toolbarContainer.remove()
      }
      toolbarContainer = createElementAtPosition(
        Math.max(32, window.innerWidth - 420),
        Math.max(32, window.innerHeight / 2 - 220),
      )
      toolbarContainer.className = 'chatgptbox-toolbar-container-not-queryable'
      render(
        h(FloatingToolbar, {
          session,
          selection: '',
          container: toolbarContainer,
          triggered: true,
          closeable: true,
          prompt,
        }),
        toolbarContainer,
      )
    },
    dispose() {
      if (!toolbarContainer) return
      render(null, toolbarContainer)
      toolbarContainer.remove()
      toolbarContainer = null
    },
  }
}

function createInitialTaskState() {
  return {
    phase: 'idle',
    activeStage: null,
    checkpointAvailable: false,
    activeAttempt: false,
    retryable: false,
    taskId: null,
    generation: null,
    result: null,
    errorMessage: null,
  }
}

export function mountVideoSummaryHost({
  platform,
  bridge,
  pageIdentity: mountedPageIdentity,
  pageGeneration = 0,
  isPageCurrent = () => true,
  targetElement,
  connect = Browser.runtime.connect.bind(Browser.runtime),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const metadata = PLATFORM_METADATA[platform]
  if (!metadata) throw new Error('VIDEO_SUMMARY_PLATFORM_REQUIRED')
  if (!bridge || !targetElement) throw new Error('VIDEO_SUMMARY_HOST_TARGET_REQUIRED')
  const pageIdentity = mountedPageIdentity || bridge.getCurrentPageIdentity?.()
  if (!pageIdentity) throw new Error('VIDEO_SUMMARY_PAGE_IDENTITY_REQUIRED')
  const videoId = pageIdentity.videoId

  const container = document.createElement('div')
  container.className = 'video-summary-host'
  targetElement.prepend(container)
  const widthController = createVideoSummaryHostWidthController({ container, targetElement })
  const toolbarLauncher = createToolbarLauncher()
  const state = {
    videoTitle: '',
    sourceChoice: null,
    sourceSnapshot: null,
    selectedSubtitleTrackId: null,
    asrConfirmationVisible: false,
    taskState: createInitialTaskState(),
  }
  let disposed = false
  let snapshotRetryTimer = null
  let pendingAction = null
  let pendingStart = null

  const isCurrentPage = () =>
    !disposed &&
    isPageCurrent(pageIdentity, pageGeneration) &&
    pageIdentitiesEqual(bridge.getCurrentPageIdentity?.(), pageIdentity)

  const rerender = () => {
    if (!isCurrentPage()) return
    const busyPhase = ['starting', 'running', 'cancelling', 'reattaching'].includes(
      state.taskState.phase,
    )
    const sourceActionsDisabled = busyPhase || pendingAction !== null
    const canCancel =
      ['starting', 'running', 'cancelling'].includes(state.taskState.phase) &&
      Boolean(state.taskState.taskId) &&
      pendingAction !== 'cancel'
    const canRetrySummary =
      ['complete', 'failed'].includes(state.taskState.phase) &&
      state.taskState.checkpointAvailable === true &&
      state.taskState.activeAttempt !== true &&
      (state.taskState.phase === 'complete' || state.taskState.retryable === true) &&
      pendingAction === null
    render(
      h(VideoSummaryView, {
        platform,
        videoTitle: state.videoTitle,
        sourceChoice: state.sourceChoice,
        subtitleTracks: state.sourceSnapshot?.nativeSubtitleTracks || [],
        selectedSubtitleTrackId: state.selectedSubtitleTrackId,
        subtitleDiscoveryStatus: state.sourceSnapshot?.subtitleDiscovery?.conclusionStatus,
        asrConfirmationVisible: state.asrConfirmationVisible,
        sourceActionsDisabled,
        canCancel,
        canRetrySummary,
        taskState: state.taskState,
        onSelectSubtitleTrack: (trackId) => {
          if (!isCurrentPage()) return
          state.selectedSubtitleTrackId = trackId
          rerender()
        },
        onChooseSource: async (choice) => {
          if (!isCurrentPage()) return
          state.sourceChoice = choice
          if (choice === 'asr') {
            state.asrConfirmationVisible = true
            rerender()
            return
          }
          state.asrConfirmationVisible = false
          await startTask(choice)
        },
        onConfirmAsr: async () => {
          if (!isCurrentPage()) return
          state.asrConfirmationVisible = false
          rerender()
          await startTask('asr')
        },
        onCancelAsrConfirmation: () => {
          if (!isCurrentPage()) return
          state.asrConfirmationVisible = false
          rerender()
        },
        onArchive: archiveSummary,
        onAskAboutVideo: askAboutVideo,
        onDownloadMarkdown: downloadMarkdown,
        onDownloadTranscript: downloadTranscript,
        onSeekTo: (startMs) => {
          if (isCurrentPage()) bridge.seekTo(startMs)
        },
        onCancelTask: cancelTask,
        onRetrySummary: retrySummary,
      }),
      container,
    )
  }

  const client = createVideoSummaryPortClient({
    pageIdentity,
    pageGeneration,
    pageBridge: bridge,
    connect,
    onEvent(event) {
      if (!isCurrentPage()) return
      if (event.type === 'TASK_STATUS') {
        if (pendingAction === 'cancel') return
        state.taskState = {
          ...state.taskState,
          phase: 'running',
          activeStage: event.stage || null,
          checkpointAvailable: event.checkpointAvailable === true,
          activeAttempt: true,
          retryable: false,
          errorMessage: null,
        }
      } else if (event.type === 'TASK_CANCELLED') {
        pendingAction = null
        pendingStart = null
        TASK_BY_PAGE.delete(pageKey)
        state.taskState = createInitialTaskState()
      } else if (event.type === 'TASK_COMPLETED') {
        state.taskState = {
          ...state.taskState,
          phase: 'complete',
          activeStage: null,
          checkpointAvailable: event.checkpointAvailable === true,
          activeAttempt: false,
          retryable: false,
          result: event.result || null,
          errorMessage: null,
        }
        pendingAction = null
        if (!state.taskState.checkpointAvailable) TASK_BY_PAGE.delete(pageKey)
      } else if (event.type === 'TASK_ERROR' || event.type === 'TASK_FAILED') {
        state.taskState = {
          ...state.taskState,
          phase: 'failed',
          activeStage: null,
          checkpointAvailable: event.checkpointAvailable === true,
          activeAttempt: false,
          retryable: event.checkpointAvailable === true,
          errorMessage: event.errorCode || event.message || 'VIDEO_SUMMARY_TASK_FAILED',
        }
        pendingAction = null
        if (!state.taskState.checkpointAvailable) TASK_BY_PAGE.delete(pageKey)
      }
      rerender()
    },
    onDisconnect() {
      if (!isCurrentPage()) return
      state.taskState = {
        ...state.taskState,
        phase: state.taskState.phase === 'complete' ? 'complete' : 'disconnected',
      }
      rerender()
    },
  })
  const pageKey = createPageKey(pageIdentity)

  const snapshotNeedsRetry = (snapshot) => {
    const tracks = snapshot?.nativeSubtitleTracks
    const status =
      snapshot?.subtitleDiscovery?.status || snapshot?.subtitleDiscovery?.conclusionStatus
    return (
      Array.isArray(tracks) && tracks.length === 0 && ['unavailable', 'not-found'].includes(status)
    )
  }

  async function applySnapshot(sourceSnapshot) {
    if (!isCurrentPage()) return false
    const selectedSubtitleTrackId = selectPreferredSubtitleTrack(
      sourceSnapshot?.nativeSubtitleTracks,
      await getPreferredLanguageKey(),
    )?.id
    if (!isCurrentPage()) return false
    state.sourceSnapshot = sourceSnapshot
    state.videoTitle = sourceSnapshot?.title || state.videoTitle
    state.selectedSubtitleTrackId = selectedSubtitleTrackId
    rerender()
    return true
  }

  async function retryInitialSnapshot() {
    snapshotRetryTimer = null
    if (!isCurrentPage()) return
    try {
      await applySnapshot(await bridge.getSnapshot())
    } catch {
      return
    }
  }

  async function loadInitialSnapshot() {
    try {
      const sourceSnapshot = await bridge.getSnapshot()
      if (!(await applySnapshot(sourceSnapshot))) return
      if (snapshotNeedsRetry(sourceSnapshot)) {
        snapshotRetryTimer = setTimeoutFn(() => void retryInitialSnapshot(), 1000)
      }
    } catch (error) {
      if (!isCurrentPage()) return
      state.taskState = {
        ...state.taskState,
        phase: 'failed',
        errorMessage: error?.message || 'VIDEO_SOURCE_SNAPSHOT_FAILED',
      }
      rerender()
    }
  }

  async function getSettingsSnapshot() {
    return createVideoSummarySettingsSnapshot({
      userConfig: await getUserConfig(),
      preferredLanguage: await getPreferredLanguageKey(),
    })
  }

  async function getModelSnapshot() {
    const userConfig = await getUserConfig()
    return {
      modelName: userConfig.modelName,
      apiMode:
        userConfig.apiMode && typeof userConfig.apiMode === 'object'
          ? { ...userConfig.apiMode }
          : userConfig.apiMode,
    }
  }

  async function ensureSourceSnapshot() {
    if (!isCurrentPage()) return null
    if (pageIdentitiesEqual(state.sourceSnapshot?.pageIdentity, pageIdentity)) {
      return state.sourceSnapshot
    }
    const sourceSnapshot = await bridge.getSnapshot()
    if (!isCurrentPage()) return null
    state.sourceSnapshot = sourceSnapshot
    state.videoTitle = sourceSnapshot?.title || state.videoTitle
    return sourceSnapshot
  }

  async function startTask(choice) {
    if (!isCurrentPage() || pendingAction !== null) return
    pendingAction = 'start'
    state.taskState = {
      ...createInitialTaskState(),
      phase: 'starting',
      activeStage: 'resolving-source',
    }
    rerender()
    try {
      const sourceSnapshot = await ensureSourceSnapshot()
      if (!sourceSnapshot || !isCurrentPage()) return
      const settingsSnapshot = await getSettingsSnapshot()
      if (!isCurrentPage()) return
      const modelSnapshot = await getModelSnapshot()
      if (!isCurrentPage()) return
      const startedPromise = client.startTask({
        sourceChoice: choice,
        subtitleTrackId:
          choice === 'native-subtitle' ? state.selectedSubtitleTrackId || undefined : undefined,
        sourceSnapshot,
        settingsSnapshot,
        modelSnapshot,
      })
      pendingStart = {
        requestId: startedPromise.requestId,
        taskId: startedPromise.taskId,
      }
      state.taskState = { ...state.taskState, taskId: startedPromise.taskId }
      rerender()
      const started = await startedPromise
      if (!isCurrentPage()) return
      pendingStart = null
      if (!started.fence) return
      const task = { taskId: started.taskId, generation: started.generation }
      TASK_BY_PAGE.set(pageKey, task)
      state.taskState = {
        ...state.taskState,
        taskId: task.taskId,
        generation: task.generation,
        activeAttempt: started.fence != null,
      }
    } finally {
      if (isCurrentPage() && pendingAction === 'start') {
        pendingAction = null
        rerender()
      }
    }
  }

  async function cancelTask() {
    if (!isCurrentPage() || ['cancel', 'retry'].includes(pendingAction)) return
    const task = TASK_BY_PAGE.get(pageKey)
    const start = pendingStart
    if (!task && !start) return
    pendingAction = 'cancel'
    state.taskState = { ...state.taskState, phase: 'cancelling' }
    rerender()
    if (task) {
      await client.cancelTask(task)
      return
    }
    const cancelled = await client.cancelStart({
      targetStartRequestId: start.requestId,
      taskId: start.taskId,
    })
    if (!isCurrentPage()) return
    if (cancelled.status === 'cancelled') {
      pendingAction = null
      pendingStart = null
      state.taskState = createInitialTaskState()
    } else if (cancelled.fence) {
      const cancellingTask = {
        taskId: cancelled.fence.taskId,
        generation: cancelled.fence.generation,
      }
      TASK_BY_PAGE.set(pageKey, cancellingTask)
      state.taskState = {
        ...state.taskState,
        taskId: cancellingTask.taskId,
        generation: cancellingTask.generation,
      }
    }
    rerender()
  }

  async function retrySummary() {
    if (!isCurrentPage() || pendingAction !== null) return
    const task = TASK_BY_PAGE.get(pageKey)
    if (
      !task ||
      !['complete', 'failed'].includes(state.taskState.phase) ||
      state.taskState.checkpointAvailable !== true ||
      state.taskState.activeAttempt === true ||
      (state.taskState.phase === 'failed' && state.taskState.retryable !== true)
    ) {
      return
    }
    pendingAction = 'retry'
    state.taskState = {
      ...state.taskState,
      phase: 'running',
      activeStage: 'synthesizing-summary',
      activeAttempt: true,
    }
    rerender()
    try {
      const modelSnapshot = await getModelSnapshot()
      if (!isCurrentPage()) return
      const started = await client.retryTask({
        taskId: task.taskId,
        generation: task.generation,
        fromStage: 'synthesis',
        modelSnapshot,
      })
      if (!isCurrentPage()) return
      state.taskState = {
        ...state.taskState,
        taskId: started.taskId,
        generation: started.generation,
      }
    } finally {
      if (isCurrentPage() && pendingAction === 'retry') {
        pendingAction = null
        rerender()
      }
    }
  }

  async function archiveSummary() {
    if (!isCurrentPage() || !state.taskState.result) return
    const session = await initDefaultSession()
    if (!isCurrentPage()) return
    const preferredLanguage = await getPreferredLanguageKey()
    if (!isCurrentPage()) return
    const markdown = buildVideoSummaryMarkdown({
      title: state.videoTitle,
      result: state.taskState.result,
      preferredLanguage,
    })
    const displayTitle = state.videoTitle || videoId
    session.sessionName = `${metadata.productName} summary: ${displayTitle}`
    session.question = `Summarize the ${metadata.productName} video "${displayTitle}".`
    session.conversationRecords = [{ question: session.question, answer: markdown }]
    if (!isCurrentPage()) return
    await createSession(session)
  }

  async function askAboutVideo() {
    if (!isCurrentPage() || !state.taskState.result) return
    await toolbarLauncher.open(
      buildAskPrompt({ title: state.videoTitle, result: state.taskState.result }),
      isCurrentPage,
    )
  }

  function downloadTranscript() {
    if (!isCurrentPage()) return
    const resultSegments = state.taskState.result?.transcriptSegments
    const selectedTrack = state.sourceSnapshot?.nativeSubtitleTracks?.find(
      (track) => track.id === state.selectedSubtitleTrackId,
    )
    const segments =
      Array.isArray(selectedTrack?.cues) && selectedTrack.cues.length > 0
        ? selectedTrack.cues
        : resultSegments
    if (!Array.isArray(segments) || segments.length === 0) return
    const transcript = buildTranscriptText(segments)
    const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' })
    const filename = sanitizeFileName(state.videoTitle, metadata.fileNameFallback)
    FileSaver.saveAs(blob, `${filename}-transcript.txt`)
  }

  async function downloadMarkdown() {
    if (!isCurrentPage() || !state.taskState.result) return
    const preferredLanguage = await getPreferredLanguageKey()
    if (!isCurrentPage()) return
    const markdown = buildVideoSummaryMarkdown({
      title: state.videoTitle,
      result: state.taskState.result,
      preferredLanguage,
    })
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    FileSaver.saveAs(blob, `${sanitizeFileName(state.videoTitle, metadata.fileNameFallback)}.md`)
  }

  rerender()
  void loadInitialSnapshot()
  const previousTask = TASK_BY_PAGE.get(pageKey)
  if (previousTask) {
    pendingAction = 'attach'
    state.taskState = {
      ...state.taskState,
      phase: 'reattaching',
      taskId: previousTask.taskId,
      generation: previousTask.generation,
      activeAttempt: true,
    }
    rerender()
    void client.attachTask(previousTask).finally(() => {
      if (!isCurrentPage() || pendingAction !== 'attach') return
      pendingAction = null
      rerender()
    })
  }

  return {
    isConnected() {
      return !disposed && container.isConnected
    },
    dispose() {
      disposed = true
      if (snapshotRetryTimer !== null) {
        clearTimeoutFn(snapshotRetryTimer)
        snapshotRetryTimer = null
      }
      widthController.dispose()
      toolbarLauncher.dispose()
      client.dispose()
      render(null, container)
      container.remove()
    },
  }
}
