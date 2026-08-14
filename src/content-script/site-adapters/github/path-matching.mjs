const issuePathPattern = /\/issues\/\d+\/?$/
const pullPathPattern = /\/pull\/\d+\/?$/

function normalizeGitHubPathname(pathname) {
  if (pathname === '/') return pathname
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

export function hasGitHubPathChanged(previousPathname, currentPathname) {
  return normalizeGitHubPathname(previousPathname) !== normalizeGitHubPathname(currentPathname)
}

export function isGitHubIssuePath(pathname) {
  return issuePathPattern.test(pathname)
}

export function isGitHubPullPath(pathname) {
  return pullPathPattern.test(pathname)
}
