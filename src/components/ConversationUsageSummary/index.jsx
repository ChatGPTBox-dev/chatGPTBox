import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import {
  formatTokenCount,
  summarizeConversationUsage,
} from '../../utils/usage-metadata.mjs'

function getMetricText(label, value, reportedTurns, totalReportedTurns, t) {
  if (reportedTurns === 0) return null
  const coverage =
    reportedTurns === totalReportedTurns
      ? ''
      : ` (${t('Turns')}: ${reportedTurns}/${totalReportedTurns})`
  return `${label}: ${formatTokenCount(value)}${coverage}`
}

function ConversationUsageSummary({ records }) {
  const { t } = useTranslation()
  const summary = summarizeConversationUsage(records)
  if (summary.models.length === 0 && summary.reportedTurns === 0) return null

  const hasModels = summary.models.length > 0
  const modelText = !hasModels
    ? ''
    : summary.models.length === 1
    ? `${t('Model')}: ${summary.models[0].name}`
    : `${t('Models')}: ${summary.models.length}`
  const modelTitle = summary.models
    .map(({ name, turns }) => `${name} · ${t('Turns')}: ${turns}`)
    .join('\n')
  const usageParts = []
  if (summary.reportedTurns > 0) {
    usageParts.push(`${t('Reported usage')}: ${summary.reportedTurns}/${summary.totalTurns}`)
    usageParts.push(
      getMetricText(
        t('Input tokens'),
        summary.inputTokens,
        summary.inputReportedTurns,
        summary.reportedTurns,
        t,
      ),
      getMetricText(
        t('Output tokens'),
        summary.outputTokens,
        summary.outputReportedTurns,
        summary.reportedTurns,
        t,
      ),
      getMetricText(
        t('Total tokens'),
        summary.totalTokens,
        summary.totalReportedTurns,
        summary.reportedTurns,
        t,
      ),
      getMetricText(
        t('Cached input tokens'),
        summary.cacheReadInputTokens,
        summary.cacheReadReportedTurns,
        summary.reportedTurns,
        t,
      ),
      getMetricText(
        t('Cache write tokens'),
        summary.cacheWriteInputTokens,
        summary.cacheWriteReportedTurns,
        summary.reportedTurns,
        t,
      ),
    )
  }

  return (
    <div
      style={{
        alignItems: 'center',
        display: 'flex',
        flexWrap: 'wrap',
        fontSize: '11px',
        gap: '4px 12px',
        opacity: 0.75,
        padding: '0 15px 8px',
      }}
    >
      {hasModels && <span title={modelTitle}>{modelText}</span>}
      {usageParts.filter(Boolean).map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </div>
  )
}

ConversationUsageSummary.propTypes = {
  records: PropTypes.array,
}

export default ConversationUsageSummary
