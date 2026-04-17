import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Pre } from './Pre'
import { Hyperlink } from './Hyperlink'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'

// eslint-disable-next-line
const ThinkComponent = ({ node, children, ...props }) => {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(true)
  const isEmpty =
    !children ||
    (Array.isArray(children) &&
      // eslint-disable-next-line
      (children.length === 0 ||
        // eslint-disable-next-line
        (children.length === 1 && typeof children[0] === 'string' && children[0].trim() === '')))

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded)
  }

  return isEmpty ? (
    <></>
  ) : (
    <div
      style={{
        marginBottom: '16px',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
        overflow: 'hidden',
        transition: 'all 0.3s ease',
      }}
    >
      <div
        onClick={toggleExpanded}
        style={{
          cursor: 'pointer',
          padding: '12px 16px',
          borderBottom: isExpanded ? '1px solid rgba(255, 255, 255, 0.2)' : 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '14px',
          fontWeight: '500',
          transition: 'all 0.3s ease',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              display: 'inline-block',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              animation: isExpanded ? 'pulse 2s infinite' : 'none',
            }}
          />
          <span style={{ fontSize: '13px', letterSpacing: '0.5px' }}>
            💭 {t('Thinking Content')}
          </span>
        </div>
        <div
          style={{
            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.3s ease',
            fontSize: '12px',
          }}
        >
          ▼
        </div>
      </div>
      <div
        style={{
          maxHeight: isExpanded ? '1000px' : '0',
          overflow: 'hidden',
          transition: 'max-height 0.4s ease, padding 0.3s ease',
          padding: isExpanded ? '16px 20px' : '0 20px',
          borderTop: isExpanded ? '1px solid #e2e8f0' : 'none',
        }}
      >
        <div
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: '13px',
            lineHeight: '1.6',
            fontFamily: '"SF Mono", "Monaco", "Inconsolata", "Roboto Mono", monospace',
            opacity: isExpanded ? 1 : 0,
            transition: 'opacity 0.3s ease 0.1s',
          }}
        >
          {children}
        </div>
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}

export function MarkdownRender(props) {
  return (
    <div dir="auto">
      <ReactMarkdown
        allowedElements={[
          'div',
          'p',
          'span',

          'video',
          'img',

          'abbr',
          'acronym',
          'b',
          'blockquote',
          'code',
          'em',
          'i',
          'li',
          'ol',
          'ul',
          'strong',
          'table',
          'tr',
          'td',
          'th',

          'details',
          'summary',
          'kbd',
          'samp',
          'sub',
          'sup',
          'ins',
          'del',
          'var',
          'q',
          'dl',
          'dt',
          'dd',
          'ruby',
          'rt',
          'rp',

          'br',
          'hr',

          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',

          'thead',
          'tbody',
          'tfoot',
          'u',
          's',
          'a',
          'pre',
          'cite',

          'think',
        ]}
        unwrapDisallowed={true}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[
          rehypeRaw,
          [
            rehypeHighlight,
            {
              detect: true,
              ignoreMissing: true,
            },
          ],
        ]}
        components={{
          a: Hyperlink,
          pre: Pre,
          think: ThinkComponent,
        }}
        {...props}
      >
        {props.children.replace('</think>', '\n\n</think>\n\n')}
      </ReactMarkdown>
    </div>
  )
}

MarkdownRender.propTypes = {
  ...ReactMarkdown.propTypes,
}

export default memo(MarkdownRender)
