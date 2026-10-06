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
    'Key points:',
    ...((Array.isArray(result?.keyPoints) ? result.keyPoints : []).map(
      (point) => `- ${String(point?.point || '').trim()}`,
    ) || ['- None']),
    '',
    'Chapter summaries:',
    chapterLines || '- None',
  ].join('\n')
}

function createToolbarLauncher() {
  let toolbarContainer = null
  return {
    async open(prompt) {
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
          session: await initDefaultSession(),
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
    result: null,
    errorMessage: null,
  }
}

export function mountVideoSummaryHost({
  platform,
  bridge,
  targetElement,
  connect = Browser.runtime.connect.bind(Browser.runtime),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const metadata = PLATFORM_METADATA[platform]
  if (!metadata) throw new Error('VIDEO_SUMMARY_PLATFORM_REQUIRED')
  if (!bridge || !targetElement) throw new Error('VIDEO_SUMMARY_HOST_TARGET_REQUIRED')
  const pageIdentity = bridge.getCurrentPageIdentity?.()
  if (!pageIdentity) throw new Error('VIDEO_SUMMARY_PAGE_IDENTITY_REQUIRED')
  const videoId = pageIdentity.videoId
  const pageGeneration = 0

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

  const rerender = () => {
    render(
      h(VideoSummaryView, {
        platform,
        videoTitle: state.videoTitle,
        sourceChoice: state.sourceChoice,
        subtitleTracks: state.sourceSnapshot?.nativeSubtitleTracks || [],
        selectedSubtitleTrackId: state.selectedSubtitleTrackId,
        subtitleDiscoveryStatus: state.sourceSnapshot?.subtitleDiscovery?.conclusionStatus,
        asrConfirmationVisible: state.asrConfirmationVisible,
        taskState: state.taskState,
        onSelectSubtitleTrack: (trackId) => {
          state.selectedSubtitleTrackId = trackId
          rerender()
        },
        onChooseSource: async (choice) => {
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
          state.asrConfirmationVisible = false
          rerender()
          await startTask('asr')
        },
        onCancelAsrConfirmation: () => {
          state.asrConfirmationVisible = false
          rerender()
        },
        onArchive: archiveSummary,
        onAskAboutVideo: askAboutVideo,
        onDownloadMarkdown: downloadMarkdown,
        onSeekTo: (startMs) => bridge.seekTo(startMs),
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
      if (event.type === 'TASK_STATUS') {
        state.taskState = {
          ...state.taskState,
          phase: 'running',
          activeStage: event.stage || null,
          checkpointAvailable: event.checkpointAvailable === true,
          errorMessage: null,
        }
      } else if (event.type === 'TASK_COMPLETED') {
        state.taskState = {
          phase: 'complete',
          activeStage: null,
          checkpointAvailable: event.checkpointAvailable === true,
          result: event.result || null,
          errorMessage: null,
        }
        TASK_BY_PAGE.delete(pageKey)
      } else if (event.type === 'TASK_ERROR' || event.type === 'TASK_FAILED') {
        state.taskState = {
          ...state.taskState,
          phase: 'failed',
          activeStage: null,
          errorMessage: event.errorCode || event.message || 'VIDEO_SUMMARY_TASK_FAILED',
        }
        TASK_BY_PAGE.delete(pageKey)
      }
      rerender()
    },
    onDisconnect() {
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
    if (disposed || !pageIdentitiesEqual(bridge.getCurrentPageIdentity?.(), pageIdentity))
      return false
    const selectedSubtitleTrackId = selectPreferredSubtitleTrack(
      sourceSnapshot?.nativeSubtitleTracks,
      await getPreferredLanguageKey(),
    )?.id
    if (disposed || !pageIdentitiesEqual(bridge.getCurrentPageIdentity?.(), pageIdentity))
      return false
    state.sourceSnapshot = sourceSnapshot
    state.videoTitle = sourceSnapshot?.title || state.videoTitle
    state.selectedSubtitleTrackId = selectedSubtitleTrackId
    rerender()
    return true
  }

  async function retryInitialSnapshot() {
    snapshotRetryTimer = null
    if (disposed || !pageIdentitiesEqual(bridge.getCurrentPageIdentity?.(), pageIdentity)) return
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
      if (disposed || !pageIdentitiesEqual(bridge.getCurrentPageIdentity?.(), pageIdentity)) return
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
    if (pageIdentitiesEqual(state.sourceSnapshot?.pageIdentity, pageIdentity)) {
      return state.sourceSnapshot
    }
    state.sourceSnapshot = await bridge.getSnapshot()
    state.videoTitle = state.sourceSnapshot?.title || state.videoTitle
    return state.sourceSnapshot
  }

  async function startTask(choice) {
    const sourceSnapshot = await ensureSourceSnapshot()
    state.taskState = {
      ...createInitialTaskState(),
      phase: 'starting',
      activeStage: 'resolving-source',
    }
    rerender()
    const started = await client.startTask({
      sourceChoice: choice,
      subtitleTrackId:
        choice === 'native-subtitle' ? state.selectedSubtitleTrackId || undefined : undefined,
      sourceSnapshot,
      settingsSnapshot: await getSettingsSnapshot(),
      modelSnapshot: await getModelSnapshot(),
    })
    TASK_BY_PAGE.set(pageKey, { taskId: started.taskId, generation: started.generation })
  }

  async function retrySummary() {
    state.taskState = {
      ...state.taskState,
      phase: 'running',
      activeStage: 'synthesizing-summary',
    }
    rerender()
    const task = TASK_BY_PAGE.get(pageKey)
    if (!task) return
    await client.retryTask({
      taskId: task.taskId,
      generation: task.generation,
      fromStage: 'synthesis',
      modelSnapshot: await getModelSnapshot(),
    })
  }

  async function archiveSummary() {
    if (!state.taskState.result) return
    const session = await initDefaultSession()
    const markdown = buildVideoSummaryMarkdown({
      title: state.videoTitle,
      result: state.taskState.result,
      preferredLanguage: await getPreferredLanguageKey(),
    })
    const displayTitle = state.videoTitle || videoId
    session.sessionName = `${metadata.productName} summary: ${displayTitle}`
    session.question = `Summarize the ${metadata.productName} video "${displayTitle}".`
    session.conversationRecords = [{ question: session.question, answer: markdown }]
    await createSession(session)
  }

  async function askAboutVideo() {
    if (!state.taskState.result) return
    await toolbarLauncher.open(
      buildAskPrompt({ title: state.videoTitle, result: state.taskState.result }),
    )
  }

  async function downloadMarkdown() {
    if (!state.taskState.result) return
    const markdown = buildVideoSummaryMarkdown({
      title: state.videoTitle,
      result: state.taskState.result,
      preferredLanguage: await getPreferredLanguageKey(),
    })
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    FileSaver.saveAs(blob, `${sanitizeFileName(state.videoTitle, metadata.fileNameFallback)}.md`)
  }

  rerender()
  void loadInitialSnapshot()
  const previousTask = TASK_BY_PAGE.get(pageKey)
  if (previousTask) {
    void client.attachTask(previousTask)
    state.taskState = { ...state.taskState, phase: 'reattaching' }
    rerender()
  }

  return {
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
