import { VIDEO_SUMMARY_PORT_NAME } from '../video-summary/contracts.mjs'
import { parseContentCommand } from '../video-summary/protocol.mjs'
import { authenticateVideoSummaryContentPort } from './video-summary-port-auth.mjs'

function loggerMethod(logger, level) {
  return typeof logger?.[level] === 'function' ? logger[level].bind(logger) : () => {}
}

export function createVideoSummaryRouter({
  runtime,
  coordinator,
  logger,
  startupReady = Promise.resolve(),
}) {
  const bindings = new WeakMap()
  const logWarn = loggerMethod(logger, 'warn')

  function rejectPort(port, binding, error) {
    port.onMessage.removeListener(binding.onMessage)
    port.onDisconnect.removeListener(binding.onDisconnect)
    bindings.delete(port)
    logWarn({
      event: 'video-summary-router.port-rejected',
      error: error?.message || 'VIDEO_SUMMARY_CONTENT_PORT_UNAUTHORIZED',
    })
    port.disconnect()
  }

  return {
    handleConnect(port) {
      if (port?.name !== VIDEO_SUMMARY_PORT_NAME) return false
      const binding = {
        context: null,
        onMessage: null,
        onDisconnect: null,
      }
      binding.onMessage = (value) => {
        let command
        try {
          command = parseContentCommand(value)
          if (!binding.context) {
            binding.context = authenticateVideoSummaryContentPort({
              port,
              runtime,
              pageIdentity: command.pageIdentity,
            })
          }
        } catch (error) {
          rejectPort(port, binding, error)
          return
        }
        void Promise.resolve(startupReady)
          .then(() => coordinator.handleContentCommand({ context: binding.context, port, command }))
          .catch((error) => {
            logWarn({
              event: 'video-summary-router.command-failed',
              type: command.type,
              error: error?.message || 'VIDEO_SUMMARY_ROUTER_COMMAND_FAILED',
            })
          })
      }
      binding.onDisconnect = () => {
        port.onMessage.removeListener(binding.onMessage)
        port.onDisconnect.removeListener(binding.onDisconnect)
        bindings.delete(port)
        if (binding.context) coordinator.handleContentDisconnect({ context: binding.context, port })
      }
      bindings.set(port, binding)
      port.onMessage.addListener(binding.onMessage)
      port.onDisconnect.addListener(binding.onDisconnect)
      return true
    },
    handleTabRemoved(tabId) {
      coordinator.handleTabRemoved(tabId)
    },
  }
}
