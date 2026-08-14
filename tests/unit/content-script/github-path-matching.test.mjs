import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hasGitHubPathChanged,
  isGitHubIssuePath,
  isGitHubPullPath,
} from '../../../src/content-script/site-adapters/github/path-matching.mjs'

test('GitHub thread paths allow an optional trailing slash', () => {
  assert.equal(isGitHubIssuePath('/owner/repo/issues/123'), true)
  assert.equal(isGitHubIssuePath('/owner/repo/issues/123/'), true)
  assert.equal(isGitHubPullPath('/owner/repo/pull/456'), true)
  assert.equal(isGitHubPullPath('/owner/repo/pull/456/'), true)
})

test('GitHub thread matching ignores query strings and fragments via pathname', () => {
  const issueUrl = new URL(
    'https://github.com/owner/repo/issues/123?notification_referrer_id=abc#issuecomment-456',
  )
  const pullUrl = new URL('https://github.com/owner/repo/pull/456?foo=bar#discussion_r789')

  assert.equal(isGitHubIssuePath(issueUrl.pathname), true)
  assert.equal(isGitHubPullPath(pullUrl.pathname), true)
})

test('GitHub navigation ignores equivalent pathname variants', () => {
  const issuePath = '/owner/repo/issues/123'
  const pullPath = '/owner/repo/pull/456'

  assert.equal(hasGitHubPathChanged(issuePath, `${issuePath}/`), false)
  assert.equal(hasGitHubPathChanged(`${issuePath}/`, issuePath), false)
  assert.equal(hasGitHubPathChanged(pullPath, `${pullPath}/`), false)
  assert.equal(hasGitHubPathChanged('/', '/'), false)
})

test('GitHub navigation refreshes only when the normalized pathname changes', () => {
  const original = new URL('https://github.com/owner/repo/issues/123')
  const comment = new URL('https://github.com/owner/repo/issues/123#issuecomment-456')
  const notification = new URL(
    'https://github.com/owner/repo/issues/123?notification_referrer_id=abc',
  )
  const nextIssue = new URL('https://github.com/owner/repo/issues/124/')

  assert.equal(hasGitHubPathChanged(original.pathname, comment.pathname), false)
  assert.equal(hasGitHubPathChanged(original.pathname, notification.pathname), false)
  assert.equal(hasGitHubPathChanged(original.pathname, nextIssue.pathname), true)
})

test('GitHub thread matching excludes lists, new issues, and pull subpages', () => {
  assert.equal(isGitHubIssuePath('/owner/repo/issues'), false)
  assert.equal(isGitHubIssuePath('/owner/repo/issues/new'), false)
  assert.equal(isGitHubPullPath('/owner/repo/pulls'), false)
  assert.equal(isGitHubPullPath('/owner/repo/pull/456/files'), false)
  assert.equal(isGitHubPullPath('/owner/repo/pull/456/commits'), false)
  assert.equal(isGitHubPullPath('/owner/repo/pull/456/checks'), false)
})
