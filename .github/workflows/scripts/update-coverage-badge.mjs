import fs from 'node:fs'
import path from 'node:path'

const coverageSummaryPath = 'coverage/coverage-summary.json'
const badgePath = 'badges/coverage.json'

function getBadgeColor(percentage) {
  if (percentage >= 90) return 'brightgreen'
  if (percentage >= 80) return 'green'
  if (percentage >= 70) return 'yellowgreen'
  if (percentage >= 60) return 'yellow'
  if (percentage >= 50) return 'orange'
  return 'red'
}

function main() {
  if (!fs.existsSync(coverageSummaryPath)) {
    throw new Error(`Coverage summary file not found: ${coverageSummaryPath}`)
  }

  const summary = JSON.parse(fs.readFileSync(coverageSummaryPath, 'utf8'))
  const linesPercentage = Number(summary?.total?.lines?.pct)

  if (!Number.isFinite(linesPercentage)) {
    throw new Error('Unable to read lines coverage percentage from coverage summary')
  }

  const roundedPercentage = Number(linesPercentage.toFixed(2))
  const badge = {
    schemaVersion: 1,
    label: 'coverage',
    message: `${roundedPercentage}%`,
    color: getBadgeColor(roundedPercentage),
  }

  fs.mkdirSync(path.dirname(badgePath), { recursive: true })
  fs.writeFileSync(badgePath, JSON.stringify(badge, null, 2) + '\n')
  console.log(`Updated ${badgePath} with lines coverage ${roundedPercentage}%`)
}

main()
