import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import { modelNameToDesc } from '../../utils/model-name-convert.mjs'
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

  const models = summary.models.map(({ name, turns }) => ({
    name: modelNameToDesc(name, t),
    turns,
  }))
  const hasModels = models.length > 0
  const modelReportedTurns = models.reduce((total, { turns }) => total + turns, 0)
  const modelCoverage =
    modelReportedTurns === summary.totalTurns
      ? ''
      : ` (${t('Turns')}: ${modelReportedTurns}/${summary.totalTurns})`
  const modelText = !hasModels
    ? ''
    : models.length === 1
    ? `${t('Model')}: ${models[0].name}${modelCoverage}`
    : `${t('Models')}: ${models.length}${modelCoverage}`
  const modelTitle = models
    .map(({ name, turns }) => `${name} · ${t('Turns')}: ${turns}`)
    .join('\n')
  const usageParts = [
    {
      key: 'reported-usage',
      text:
        summary.reportedTurns > 0
          ? `${t('Reported usage')}: ${summary.reportedTurns}/${summary.totalTurns}`
          : null,
    },
    {
      key: 'input-tokens',
      text: getMetricText(
        t('Input tokens'),
        summary.inputTokens,
        summary.inputReportedTurns,
        summary.reportedTurns,
        t,
      ),
    },
    {
      key: 'output-tokens',
      text: getMetricText(
        t('Output tokens'),
        summary.outputTokens,
        summary.outputReportedTurns,
        summary.reportedTurns,
        t,
      ),
    },
    {
      key: 'total-tokens',
      text: getMetricText(
        t('Total tokens'),
        summary.totalTokens,
        summary.totalReportedTurns,
        summary.reportedTurns,
        t,
      ),
    },
    {
      key: 'cache-read-tokens',
      text: getMetricText(
        t('Cached input tokens'),
        summary.cacheReadInputTokens,
        summary.cacheReadReportedTurns,
        summary.reportedTurns,
        t,
      ),
    },
    {
      key: 'cache-write-tokens',
      text: getMetricText(
        t('Cache write tokens'),
        summary.cacheWriteInputTokens,
        summary.cacheWriteReportedTurns,
        summary.reportedTurns,
        t,
      ),
    },
  ]

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
      {usageParts.map(({ key, text }) => {
        if (!text) return null
        return <span key={key}>{text}</span>
      })}
    </div>
  )
}

ConversationUsageSummary.propTypes = {
  records: PropTypes.array,
}

export default ConversationUsageSummary
