const issuePathPattern = /\/issues\/\d+\/?$/
const pullPathPattern = /\/pull\/\d+\/?$/

export function hasGitHubPathChanged(previousPathname, currentPathname) {
  return previousPathname !== currentPathname
}

export function isGitHubIssuePath(pathname) {
  return issuePathPattern.test(pathname)
}

export function isGitHubPullPath(pathname) {
  return pullPathPattern.test(pathname)
}
