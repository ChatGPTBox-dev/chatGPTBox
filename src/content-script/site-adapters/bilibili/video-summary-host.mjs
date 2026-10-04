import { h, render } from 'preact'
import Browser from 'webextension-polyfill'
import FileSaver from 'file-saver'
import FloatingToolbar from '../../../components/FloatingToolbar'
import BilibiliVideoSummaryView from '../../../components/BilibiliVideoSummaryView/index.jsx'
import '../../../components/BilibiliVideoSummaryView/styles.scss'
import { buildVideoSummaryMarkdown } from '../../../video-summary/markdown-export.mjs'
import { createVideoSummarySettingsSnapshot } from '../../../video-summary/settings.mjs'
import { createVideoSummaryPortClient } from './video-summary-port.mjs'
import { createVideoSummaryHostWidthController } from './video-summary-host-width.mjs'
import { selectPreferredBilibiliSubtitleTrack } from './media-source.mjs'
import { createElementAtPosition } from '../../../utils'
import { createSession, initDefaultSession } from '../../../services/local-session.mjs'
import { getPreferredLanguageKey, getUserConfig } from '../../../config/index.mjs'

const TASK_ID_BY_OWNER = new Map()

function createOwnerKey(documentId, videoId) {
  return `${documentId || 'unknown-document'}:${videoId}`
}

function sanitizeFileName(value) {
  return String(value || 'bilibili-video-summary')
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

      const position = {
        x: Math.max(32, window.innerWidth - 420),
        y: Math.max(32, window.innerHeight / 2 - 220),
      }
      toolbarContainer = createElementAtPosition(position.x, position.y)
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

export function mountBilibiliVideoSummaryHost({
  bridge,
  targetElement,
  connect = Browser.runtime.connect.bind(Browser.runtime),
}) {
  if (!bridge || !targetElement) {
    throw new Error('BILIBILI_VIDEO_SUMMARY_HOST_TARGET_REQUIRED')
  }

  const videoId = bridge.getCurrentVideoId?.()
  if (!videoId) throw new Error('BILIBILI_VIDEO_SUMMARY_VIDEO_ID_REQUIRED')

  const container = document.createElement('div')
  container.className = 'bilibili-video-summary-host'
  targetElement.prepend(container)
  const widthController = createVideoSummaryHostWidthController({ container, targetElement })

  const toolbarLauncher = createToolbarLauncher()
  const state = {
    videoTitle: '',
    sourceChoice: null,
    sourceSnapshot: null,
    asrConfirmationVisible: false,
    taskState: createInitialTaskState(),
  }

  const rerender = () => {
    const subtitleTrack = selectPreferredBilibiliSubtitleTrack(
      state.sourceSnapshot?.nativeSubtitleTracks,
    )

    render(
      h(BilibiliVideoSummaryView, {
        videoTitle: state.videoTitle,
        sourceChoice: state.sourceChoice,
        subtitleTrack,
        subtitleDiscoveryStatus: state.sourceSnapshot?.subtitleDiscovery?.conclusionStatus,
        asrConfirmationVisible: state.asrConfirmationVisible,
        taskState: state.taskState,
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
        onArchive: () => void archiveSummary(),
        onAskAboutVideo: () => void askAboutVideo(),
        onDownloadMarkdown: () => void downloadMarkdown(),
        onSeekTo: (startMs) => bridge.seekTo(startMs),
        onRetrySummary: () => void retrySummary(),
      }),
      container,
    )
  }

  const client = createVideoSummaryPortClient({
    videoId,
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
      } else if (event.type === 'TASK_RESULT') {
        state.taskState = {
          phase: 'complete',
          activeStage: null,
          checkpointAvailable: event.checkpointAvailable === true,
          result: event.result || null,
          errorMessage: null,
        }
        TASK_ID_BY_OWNER.delete(ownerKey)
      } else if (event.type === 'TASK_ERROR' || event.type === 'TASK_FAILED') {
        state.taskState = {
          ...state.taskState,
          phase: 'failed',
          activeStage: null,
          errorMessage: event.errorCode || event.message || 'VIDEO_SUMMARY_TASK_FAILED',
        }
        TASK_ID_BY_OWNER.delete(ownerKey)
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
  const ownerKey = createOwnerKey(client.getDocumentId(), videoId)

  async function loadInitialSnapshot() {
    try {
      const sourceSnapshot = await bridge.getSnapshot()
      state.sourceSnapshot = sourceSnapshot
      state.videoTitle = sourceSnapshot?.title || state.videoTitle
      rerender()
    } catch (error) {
      state.taskState = {
        ...state.taskState,
        phase: 'failed',
        errorMessage: error?.message || 'BILIBILI_SOURCE_SNAPSHOT_FAILED',
      }
      rerender()
    }
  }

  async function getSettingsSnapshot() {
    const userConfig = await getUserConfig()
    return createVideoSummarySettingsSnapshot({
      userConfig,
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
    if (state.sourceSnapshot?.videoId === videoId) return state.sourceSnapshot
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
    const taskId = await client.startTask({
      sourceChoice: choice,
      subtitleTrackId:
        choice === 'native-subtitle'
          ? selectPreferredBilibiliSubtitleTrack(sourceSnapshot.nativeSubtitleTracks)?.id
          : undefined,
      sourceSnapshot,
      settingsSnapshot: await getSettingsSnapshot(),
      modelSnapshot: await getModelSnapshot(),
    })
    TASK_ID_BY_OWNER.set(ownerKey, taskId)
  }

  async function retrySummary() {
    state.taskState = {
      ...state.taskState,
      phase: 'running',
      activeStage: 'synthesizing-summary',
    }
    rerender()
    await client.retryTask({
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

    session.sessionName = `Bilibili summary: ${state.videoTitle || videoId}`
    session.question = `Summarize the Bilibili video "${state.videoTitle || videoId}".`
    session.conversationRecords = [
      {
        question: session.question,
        answer: markdown,
      },
    ]

    await createSession(session)
  }

  async function askAboutVideo() {
    if (!state.taskState.result) return
    await toolbarLauncher.open(
      buildAskPrompt({
        title: state.videoTitle,
        result: state.taskState.result,
      }),
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
    FileSaver.saveAs(blob, `${sanitizeFileName(state.videoTitle || videoId)}.md`)
  }

  rerender()
  void loadInitialSnapshot()

  const previousTaskId = TASK_ID_BY_OWNER.get(ownerKey)
  if (previousTaskId) {
    void client.attachTask({ taskId: previousTaskId })
    state.taskState = {
      ...state.taskState,
      phase: 'reattaching',
    }
    rerender()
  }

  return {
    dispose() {
      widthController.dispose()
      toolbarLauncher.dispose()
      client.dispose()
      render(null, container)
      container.remove()
    },
  }
}
