import {
  FETCH_REQUEST_FAILED,
  FETCH_RESPONSE_STREAM_FAILED,
  INVALID_API_ENDPOINT,
} from '../utils/fetch-sse.mjs'
import { isAbortError } from '../utils/abort-error.mjs'
import { formatErrorMessage } from '../utils/error-text.mjs'

const delegatedErrorCodes = new Set([
  FETCH_REQUEST_FAILED,
  FETCH_RESPONSE_STREAM_FAILED,
  INVALID_API_ENDPOINT,
])

export function shouldDelegatePortError(err) {
  return delegatedErrorCodes.has(err?.code) || isAbortError(err)
}

export function getPortErrorMessage(err) {
  return err?.message
    ? formatErrorMessage(err.message)
    : 'An unexpected error occurred in content script port listener.'
}
