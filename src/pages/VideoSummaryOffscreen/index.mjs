import Browser from 'webextension-polyfill'
import { VIDEO_SUMMARY_OFFSCREEN_PORT_NAME } from '../../video-summary/contracts.mjs'
import { startVideoSummaryOffscreenRuntime } from './runtime.mjs'

const VIDEO_SUMMARY_TASKS_DIR = 'video-summary-tasks'

async function deleteDirectoryChildren(directoryHandle) {
  if (!directoryHandle || typeof directoryHandle.values !== 'function') return

  for await (const entry of directoryHandle.values()) {
    if (!entry?.name) continue
    await directoryHandle.removeEntry(entry.name, { recursive: true })
  }
}

export async function cleanupVideoSummaryTaskArtifacts({
  getDirectory = globalThis.navigator?.storage?.getDirectory?.bind(globalThis.navigator?.storage),
} = {}) {
  if (typeof getDirectory !== 'function') return false

  const root = await getDirectory()
  try {
    const tasksDirectory = await root.getDirectoryHandle(VIDEO_SUMMARY_TASKS_DIR)
    await deleteDirectoryChildren(tasksDirectory)
    return true
  } catch (error) {
    if (error?.name === 'NotFoundError') return false
    throw error
  }
}

export async function bootstrapVideoSummaryOffscreen({ runtime = Browser.runtime } = {}) {
  await cleanupVideoSummaryTaskArtifacts()
  const port = runtime.connect({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const offscreenRuntime = startVideoSummaryOffscreenRuntime({ port })
  return { port, offscreenRuntime }
}

bootstrapVideoSummaryOffscreen().catch((error) => {
  console.error('[video-summary-offscreen] bootstrap failed:', error)
})
