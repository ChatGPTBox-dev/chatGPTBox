export function resolvePageMode({ config, capabilities, pageIdentity, pageState }) {
  if (
    typeof pageState?.enhancedSupported !== 'boolean' ||
    typeof pageState?.legacySupported !== 'boolean'
  ) {
    throw new Error('VIDEO_SUMMARY_PAGE_STATE_INVALID')
  }

  const adapterEnabled =
    !Array.isArray(config?.activeSiteAdapters) ||
    config.activeSiteAdapters.includes(pageIdentity?.platform)
  if (
    pageIdentity &&
    pageState.enhancedSupported &&
    capabilities?.enhanced === true &&
    adapterEnabled
  ) {
    return 'enhanced'
  }
  return pageState.legacySupported ? 'legacy' : 'none'
}
