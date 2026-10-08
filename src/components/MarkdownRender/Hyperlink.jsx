import PropTypes from 'prop-types'
import Browser from 'webextension-polyfill'

export function Hyperlink({ href, children }) {
  const linkProperties = {
    target: '_blank',
    style: 'color: #8ab4f8; cursor: pointer;',
    rel: 'nofollow noopener noreferrer',
  }

  // A destination can be missing by the time the anchor gets here -- the renderer strips one it
  // refuses to allow, and raw HTML can leave it out. Rendering the children keeps the reply
  // readable, where a lookup on the missing string would throw and take the answer down with it.
  if (typeof href !== 'string' || href === '') return children

  return href.includes('chatgpt.com') ||
    href.includes('claude.ai') ||
    href.includes('kimi.moonshot.cn') ||
    href.includes('kimi.com') ? (
    <span
      {...linkProperties}
      onClick={() => {
        const url = new URL(href)
        url.searchParams.set('chatgptbox_notification', 'true')
        Browser.runtime.sendMessage({
          type: 'NEW_URL',
          data: {
            url: url.toString(),
            pinned: false,
            jumpBack: true,
          },
        })
      }}
    >
      {children}
    </span>
  ) : (
    <a href={href} {...linkProperties}>
      {children}
    </a>
  )
}

Hyperlink.propTypes = {
  href: PropTypes.string,
  children: PropTypes.node.isRequired,
}
