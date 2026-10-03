/**
 * The "waiting for response" placeholder the card shows until the first answer chunk arrives.
 *
 * Both the card, which writes it, and the streaming renderer, which must not mistake it for
 * answer text, build it from this one template, so the two can never drift apart.
 *
 * @param {(key: string) => string} t translation function
 * @returns {string}
 */
export function waitingPlaceholder(t) {
  return `<p class="gpt-loading">${t('Waiting for response...')}</p>`
}
