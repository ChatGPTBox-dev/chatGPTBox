/**
 * Storage keys that live next to the user config but are not part of it.
 *
 * Conversation history is rewritten after every finished message, so it must
 * not be treated as a config change by anything that reacts to storage events.
 */
export const NON_CONFIG_STORAGE_KEYS = ['sessions']

/**
 * Whether a storage event carries a change to the user config.
 *
 * Only the key matters, not the reported values. Both browsers report the keys
 * of the call that changed storage, so a conversation history write only ever
 * mentions `sessions`; Firefox additionally reports keys whose value did not
 * actually change, which costs a cache miss and can never serve a stale config.
 */
export function hasConfigStorageChange(changes) {
  return Object.keys(changes).some((key) => !NON_CONFIG_STORAGE_KEYS.includes(key))
}
