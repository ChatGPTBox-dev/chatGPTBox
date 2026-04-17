import PropTypes from 'prop-types'

const siteDisplayNames = {
  bilibili: 'Bilibili',
  github: 'GitHub',
  gitlab: 'GitLab',
  quora: 'Quora',
  reddit: 'Reddit',
  youtube: 'YouTube',
  zhihu: 'Zhihu',
  stackoverflow: 'Stack Overflow',
  juejin: 'Juejin',
  'mp.weixin.qq': 'WeChat MP',
  followin: 'Followin',
  arxiv: 'arXiv',
}

SiteAdapters.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

export function SiteAdapters({ config, updateConfig }) {
  return (
    <>
      {config.siteAdapters.map((key) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={config.activeSiteAdapters.includes(key)}
            onChange={(e) => {
              const checked = e.target.checked
              const activeSiteAdapters = config.activeSiteAdapters.filter((i) => i !== key)
              if (checked) activeSiteAdapters.push(key)
              updateConfig({ activeSiteAdapters })
            }}
          />
          {siteDisplayNames[key] || key}
        </label>
      ))}
    </>
  )
}
