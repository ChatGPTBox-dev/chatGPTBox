import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVideoSummaryRouter,
  routeKeyOf,
} from '../../../src/background/video-summary-router.mjs'
import { createVideoSummaryOwner } from '../../../src/video-summary/contracts.mjs'
import { createFakePort } from '../helpers/port.mjs'

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  }
}

function createFakeClock(start = 1_000) {
  let now = start
  let nextTimerId = 1
  const timers = new Map()

  return {
    now: () => now,
    setTimeout(callback, delay) {
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, { callback, dueAt: now + delay })
      return timerId
    },
    clearTimeout(timerId) {
      timers.delete(timerId)
    },
    advance(ms) {
      now += ms
      const dueTimers = Array.from(timers.entries())
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)

      for (const [timerId, timer] of dueTimers) {
        timers.delete(timerId)
        timer.callback()
      }
    },
  }
}

function createCommandSink() {
  const commands = []
  return {
    commands,
    emitCommand(command) {
      commands.push(structuredClone(command))
    },
  }
}

test('router stamps owner identity from port.sender and ignores spoofed owner fields', async () => {
  const commandSink = createCommandSink()
  const router = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway: {},
    ensureOffscreenDocument: async () => {},
    clock: createFakeClock(),
    logger: createLogger(),
    emitCommand: commandSink.emitCommand,
  })

  const port = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: 7 }, documentId: 'doc-7' },
  })

  await router.handleConnect(port)
  port.emitMessage({
    type: 'START_TASK',
    taskId: 'task-1',
    videoId: 'BV1test',
    owner: { tabId: 999, documentId: 'spoofed', videoId: 'BV1spoofed' },
    settingsSnapshot: { speakerIdentification: true },
  })

  const owner = createVideoSummaryOwner({ tabId: 7, documentId: 'doc-7', videoId: 'BV1test' })
  assert.deepEqual(router.debugRoutes().get(routeKeyOf(owner))?.owner, owner)
  assert.equal(router.debugRoutes().get(routeKeyOf(owner))?.taskId, 'task-1')
  assert.deepEqual(commandSink.commands, [
    {
      type: 'START_TASK',
      taskId: 'task-1',
      videoId: 'BV1test',
      owner,
      settingsSnapshot: { speakerIdentification: true },
    },
  ])
})

test('exact ATTACH_TASK within grace rebinds the route after disconnect but mismatches and expiry cancel it', async () => {
  const clock = createFakeClock()
  const commandSink = createCommandSink()
  const router = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway: {},
    ensureOffscreenDocument: async () => {},
    clock,
    logger: createLogger(),
    emitCommand: commandSink.emitCommand,
  })

  const owner = createVideoSummaryOwner({ tabId: 9, documentId: 'doc-9', videoId: 'BV9test' })
  const firstPort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })

  await router.handleConnect(firstPort)
  firstPort.emitMessage({
    type: 'START_TASK',
    taskId: 'task-9',
    videoId: owner.videoId,
  })
  firstPort.emitDisconnect()

  const replacementPort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })
  await router.handleConnect(replacementPort)
  replacementPort.emitMessage({
    type: 'ATTACH_TASK',
    taskId: 'task-9',
    videoId: owner.videoId,
  })

  assert.equal(router.debugRoutes().get(routeKeyOf(owner))?.port, replacementPort)

  replacementPort.emitDisconnect()
  clock.advance(15_001)

  assert.equal(router.debugRoutes().has(routeKeyOf(owner)), false)
  assert.deepEqual(commandSink.commands.at(-1), {
    type: 'CANCEL_TASK',
    taskId: 'task-9',
    owner,
    reason: 'OWNER_DISCONNECTED',
  })

  const staleAttachPort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })
  await router.handleConnect(staleAttachPort)
  staleAttachPort.emitMessage({
    type: 'ATTACH_TASK',
    taskId: 'task-9',
    videoId: owner.videoId,
  })
  assert.equal(router.debugRoutes().has(routeKeyOf(owner)), false)

  const wrongTaskPort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })
  await router.handleConnect(wrongTaskPort)
  wrongTaskPort.emitMessage({
    type: 'ATTACH_TASK',
    taskId: 'task-other',
    videoId: owner.videoId,
  })
  assert.equal(router.debugRoutes().has(routeKeyOf(owner)), false)
})

test('ATTACH_TASK can rebuild a missing route only during the initial restart grace window', async () => {
  const clock = createFakeClock()
  const commandSink = createCommandSink()
  const owner = createVideoSummaryOwner({ tabId: 11, documentId: 'doc-11', videoId: 'BV11test' })

  const freshRouter = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway: {},
    ensureOffscreenDocument: async () => {},
    clock,
    logger: createLogger(),
    emitCommand: commandSink.emitCommand,
  })
  const freshPort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })

  await freshRouter.handleConnect(freshPort)
  freshPort.emitMessage({
    type: 'ATTACH_TASK',
    taskId: 'task-11',
    videoId: owner.videoId,
  })

  assert.equal(freshRouter.debugRoutes().get(routeKeyOf(owner))?.taskId, 'task-11')
  assert.deepEqual(commandSink.commands, [
    {
      type: 'ATTACH_TASK',
      taskId: 'task-11',
      videoId: owner.videoId,
      owner,
    },
  ])

  const lateClock = createFakeClock()
  const lateCommandSink = createCommandSink()
  const lateRouter = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway: {},
    ensureOffscreenDocument: async () => {},
    clock: lateClock,
    logger: createLogger(),
    emitCommand: lateCommandSink.emitCommand,
  })
  lateClock.advance(15_001)
  const latePort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })

  await lateRouter.handleConnect(latePort)
  latePort.emitMessage({
    type: 'ATTACH_TASK',
    taskId: 'task-11',
    videoId: owner.videoId,
  })

  assert.equal(lateRouter.debugRoutes().has(routeKeyOf(owner)), false)
  assert.deepEqual(lateCommandSink.commands, [])
})

test('handleTaskEvent forwards only the exact current task and owner to the active route', async () => {
  const router = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway: {},
    ensureOffscreenDocument: async () => {},
    clock: createFakeClock(),
    logger: createLogger(),
    emitCommand() {},
  })
  const owner = createVideoSummaryOwner({ tabId: 3, documentId: 'doc-3', videoId: 'BV3test' })
  const port = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })

  await router.handleConnect(port)
  port.emitMessage({
    type: 'START_TASK',
    taskId: 'task-3',
    videoId: owner.videoId,
  })

  router.handleTaskEvent({
    type: 'TASK_STATUS',
    taskId: 'task-3',
    owner,
    stage: 'transcribing',
  })
  router.handleTaskEvent({
    type: 'TASK_STATUS',
    taskId: 'task-stale',
    owner,
    stage: 'ignored',
  })
  router.handleTaskEvent({
    type: 'TASK_STATUS',
    taskId: 'task-3',
    owner: { ...owner, videoId: 'BV-wrong' },
    stage: 'ignored',
  })

  assert.deepEqual(port.postedMessages, [
    {
      type: 'TASK_STATUS',
      taskId: 'task-3',
      owner,
      stage: 'transcribing',
    },
  ])
})

test('requestSourceRefresh and tab removal target only the matching owner route', async () => {
  const commandSink = createCommandSink()
  const router = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway: {},
    ensureOffscreenDocument: async () => {},
    clock: createFakeClock(),
    logger: createLogger(),
    emitCommand: commandSink.emitCommand,
  })
  const owner = createVideoSummaryOwner({ tabId: 5, documentId: 'doc-5', videoId: 'BV5test' })
  const otherOwner = createVideoSummaryOwner({ tabId: 6, documentId: 'doc-6', videoId: 'BV6test' })
  const firstPort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: owner.tabId }, documentId: owner.documentId },
  })
  const secondPort = createFakePort({
    name: 'bilibili-video-summary',
    sender: { tab: { id: otherOwner.tabId }, documentId: otherOwner.documentId },
  })

  await router.handleConnect(firstPort)
  firstPort.emitMessage({ type: 'START_TASK', taskId: 'task-5', videoId: owner.videoId })
  await router.handleConnect(secondPort)
  secondPort.emitMessage({ type: 'START_TASK', taskId: 'task-6', videoId: otherOwner.videoId })

  router.requestSourceRefresh(owner, 'task-5')
  router.handleTabRemoved(owner.tabId)

  assert.deepEqual(firstPort.postedMessages, [
    {
      type: 'REQUEST_SOURCE_REFRESH',
      taskId: 'task-5',
      owner,
    },
  ])
  assert.deepEqual(secondPort.postedMessages, [])
  assert.deepEqual(commandSink.commands.at(-1), {
    type: 'CANCEL_TASK',
    taskId: 'task-5',
    owner,
    reason: 'OWNER_TAB_REMOVED',
  })
  assert.equal(router.debugRoutes().has(routeKeyOf(owner)), false)
  assert.equal(router.debugRoutes().has(routeKeyOf(otherOwner)), true)
})
