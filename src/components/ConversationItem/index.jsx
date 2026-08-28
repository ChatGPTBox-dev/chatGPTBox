import { memo, useState } from 'react'
import { ChevronDownIcon, XCircleIcon, SyncIcon } from '@primer/octicons-react'
import CopyButton from '../CopyButton'
import ReadButton from '../ReadButton'
import PropTypes from 'prop-types'
import MarkdownRender from '../MarkdownRender/markdown.jsx'
import { useTranslation } from 'react-i18next'
import { formatTokenCount, getRecordModel } from '../../utils/usage-metadata.mjs'

function getUsageText(meta, t) {
  const usage = meta?.usage
  if (!usage) return ''

  const parts = []
  if (usage.inputTokens !== undefined)
    parts.push(`${t('Input tokens')}: ${formatTokenCount(usage.inputTokens)}`)
  if (usage.outputTokens !== undefined)
    parts.push(`${t('Output tokens')}: ${formatTokenCount(usage.outputTokens)}`)
  if (usage.cacheReadInputTokens !== undefined)
    parts.push(`${t('Cached input tokens')}: ${formatTokenCount(usage.cacheReadInputTokens)}`)
  if (usage.cacheWriteInputTokens !== undefined)
    parts.push(`${t('Cache write tokens')}: ${formatTokenCount(usage.cacheWriteInputTokens)}`)
  if (parts.length === 0 && usage.totalTokens !== undefined) {
    parts.push(`${t('Total tokens')}: ${formatTokenCount(usage.totalTokens)}`)
  }
  return parts.join(' · ')
}

function AnswerTitle({ descName, meta }) {
  const { t } = useTranslation()
  const model = getRecordModel(meta, descName)
  const usageText = getUsageText(meta, t)
  const selectedModel = meta?.selectedModel
  const reportedModel = meta?.reportedModel
  const modelTitle =
    selectedModel && reportedModel && selectedModel !== reportedModel
      ? `${t('Selected model')}: ${selectedModel}\n${t('Reported model')}: ${reportedModel}`
      : model

  return (
    <div style={{ minWidth: 0 }}>
      <p
        title={modelTitle}
        style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {model ? `${model}:` : t('Loading...')}
      </p>
      {usageText && (
        <p
          title={usageText}
          style={{ fontSize: '11px', margin: 0, opacity: 0.72, whiteSpace: 'normal' }}
        >
          {usageText}
        </p>
      )}
    </div>
  )
}

AnswerTitle.propTypes = {
  descName: PropTypes.string,
  meta: PropTypes.object,
}

export function ConversationItem({ type, content, descName, meta, onRetry }) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)

  switch (type) {
    case 'question':
      return (
        <div className={'chatgptbox-' + type} dir="auto">
          <div className="gpt-header">
            <p>{t('You')}:</p>
            <div className="gpt-util-group">
              <CopyButton contentFn={() => content.replace(/\n<hr\/>$/, '')} size={14} />
              <ReadButton contentFn={() => content} size={14} />
              {!collapsed ? (
                <span
                  title={t('Collapse')}
                  className="gpt-util-icon"
                  onClick={() => setCollapsed(true)}
                >
                  <XCircleIcon size={14} />
                </span>
              ) : (
                <span
                  title={t('Expand')}
                  className="gpt-util-icon"
                  onClick={() => setCollapsed(false)}
                >
                  <ChevronDownIcon size={14} />
                </span>
              )}
            </div>
          </div>
          {!collapsed && <MarkdownRender>{content}</MarkdownRender>}
        </div>
      )
    case 'answer':
      return (
        <div className={'chatgptbox-' + type} dir="auto">
          <div className="gpt-header">
            <AnswerTitle descName={descName} meta={meta} />
            <div className="gpt-util-group">
              {onRetry && (
                <span title={t('Retry')} className="gpt-util-icon" onClick={onRetry}>
                  <SyncIcon size={14} />
                </span>
              )}
              {descName && (
                <CopyButton contentFn={() => content.replace(/\n<hr\/>$/, '')} size={14} />
              )}
              {descName && <ReadButton contentFn={() => content} size={14} />}
              {!collapsed ? (
                <span
                  title={t('Collapse')}
                  className="gpt-util-icon"
                  onClick={() => setCollapsed(true)}
                >
                  <XCircleIcon size={14} />
                </span>
              ) : (
                <span
                  title={t('Expand')}
                  className="gpt-util-icon"
                  onClick={() => setCollapsed(false)}
                >
                  <ChevronDownIcon size={14} />
                </span>
              )}
            </div>
          </div>
          {!collapsed && <MarkdownRender>{content}</MarkdownRender>}
        </div>
      )
    case 'error':
      return (
        <div className={'chatgptbox-' + type} dir="auto">
          <div className="gpt-header">
            <p>{t('Error')}:</p>
            <div className="gpt-util-group">
              {onRetry && (
                <span title={t('Retry')} className="gpt-util-icon" onClick={onRetry}>
                  <SyncIcon size={14} />
                </span>
              )}
              <CopyButton contentFn={() => content.replace(/\n<hr\/>$/, '')} size={14} />
              {!collapsed ? (
                <span
                  title={t('Collapse')}
                  className="gpt-util-icon"
                  onClick={() => setCollapsed(true)}
                >
                  <XCircleIcon size={14} />
                </span>
              ) : (
                <span
                  title={t('Expand')}
                  className="gpt-util-icon"
                  onClick={() => setCollapsed(false)}
                >
                  <ChevronDownIcon size={14} />
                </span>
              )}
            </div>
          </div>
          {!collapsed && <MarkdownRender>{content}</MarkdownRender>}
        </div>
      )
  }
}

ConversationItem.propTypes = {
  type: PropTypes.oneOf(['question', 'answer', 'error']).isRequired,
  content: PropTypes.string.isRequired,
  descName: PropTypes.string,
  meta: PropTypes.object,
  onRetry: PropTypes.func,
}

export default memo(ConversationItem)
