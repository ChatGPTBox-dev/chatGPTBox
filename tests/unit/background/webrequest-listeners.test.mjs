import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  bingHeaderRewrites,
  claudeHeaderRewrites,
  registerBlockingHeaderListeners,
} from '../../../src/background/webrequest-listeners.mjs'

const readSrcJson = (relativePath) =>
  JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))

const createRecordingWebRequest = () => {
  const registrations = []
  return {
    registrations,
    webRequest: {
      onBeforeSendHeaders: {
        addListener: (listener, filter, extraInfoSpec) => {
          registrations.push({ listener, filter, extraInfoSpec })
        },
      },
    },
  }
}

const registerManifestV2Listeners = () => {
  const { registrations, webRequest } = createRecordingWebRequest()
  const count = registerBlockingHeaderListeners(webRequest, 2)
  return { registrations, count }
}

const headerValue = (headers, name) =>
  headers.find((header) => header?.name?.toLowerCase() === name)?.value

const hostFromUrlPattern = (pattern) => pattern.match(/^[a-z]+:\/\/([^/]+)/i)[1]

// Look listeners up by the host their filter matches, so the tests do not
// depend on the registration order of the two addListener calls.
const registrationFor = (registrations, host) => {
  const registration = registrations.find((candidate) =>
    candidate.filter.urls.some((pattern) => hostFromUrlPattern(pattern) === host),
  )
  assert.ok(registration, `expected a registered listener for ${host}`)
  return registration
}

const bingRegistration = (registrations) => registrationFor(registrations, 'www.bing.com')
const claudeRegistration = (registrations) => registrationFor(registrations, 'claude.ai')

test('registerBlockingHeaderListeners registers nothing on manifest v3 and above', () => {
  for (const manifestVersion of [3, 4]) {
    const { registrations, webRequest } = createRecordingWebRequest()
    const count = registerBlockingHeaderListeners(webRequest, manifestVersion)
    assert.equal(count, 0)
    assert.equal(registrations.length, 0)
  }
})

test('registerBlockingHeaderListeners registers nothing without the webRequest API', () => {
  for (const webRequest of [undefined, null, {}, { onBeforeSendHeaders: {} }]) {
    assert.equal(registerBlockingHeaderListeners(webRequest, 2), 0)
  }
})

test('registerBlockingHeaderListeners registers both blocking listeners on manifest v2', () => {
  const { registrations, count } = registerManifestV2Listeners()
  assert.equal(count, registrations.length)
  assert.equal(count, 2)

  for (const registration of registrations) {
    assert.deepEqual(registration.extraInfoSpec, ['requestHeaders', 'blocking'])
    // Chromium hides Origin/Referer unless `extraHeaders` is requested, but
    // Firefox throws on that value and manifest v2 is served to Firefox (and
    // to Safari via the Firefox build), so it must stay out.
    assert.equal(registration.extraInfoSpec.includes('extraHeaders'), false)
  }
  assert.deepEqual(bingRegistration(registrations).filter, {
    urls: ['wss://sydney.bing.com/*', 'https://www.bing.com/*'],
    types: ['xmlhttprequest', 'websocket'],
  })
  assert.deepEqual(claudeRegistration(registrations).filter, {
    urls: ['https://claude.ai/*'],
    types: ['xmlhttprequest'],
  })
})

test('Bing listener rewrites existing origin and referer headers', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'debug', () => {})
  const { registrations } = registerManifestV2Listeners()

  const headers = [
    { name: 'Origin', value: 'https://example.com' },
    { name: 'Referer', value: 'https://example.com/page' },
    { name: 'Accept', value: '*/*' },
  ]
  const result = bingRegistration(registrations).listener({
    url: 'https://www.bing.com/',
    requestHeaders: headers,
  })

  assert.equal(headerValue(result.requestHeaders, 'origin'), bingHeaderRewrites.origin)
  assert.equal(headerValue(result.requestHeaders, 'referer'), bingHeaderRewrites.referer)
  assert.equal(headerValue(result.requestHeaders, 'accept'), '*/*')
  assert.equal(consoleError.mock.callCount(), 0)
})

test('Claude listener rewrites existing origin and referer headers', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'debug', () => {})
  const { registrations } = registerManifestV2Listeners()

  const headers = [
    { name: 'origin', value: 'https://example.com' },
    { name: 'referer', value: 'https://example.com/page' },
  ]
  const result = claudeRegistration(registrations).listener({
    url: 'https://claude.ai/',
    requestHeaders: headers,
  })

  assert.equal(headerValue(result.requestHeaders, 'origin'), claudeHeaderRewrites.origin)
  assert.equal(headerValue(result.requestHeaders, 'referer'), claudeHeaderRewrites.referer)
  assert.equal(consoleError.mock.callCount(), 0)
})

test('listeners neither touch nor add headers the request does not have', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'debug', () => {})
  const { registrations } = registerManifestV2Listeners()

  // Documented difference: the manifest v3 DNR rules use `set`, which also adds
  // Origin/Referer when the request has none, while these manifest v2 listeners
  // only replace existing headers. Only the manifest v2 side is asserted here,
  // because the v3 side is enforced declaratively by rules.json.
  for (const registration of registrations) {
    const headers = [{ name: 'Accept', value: '*/*' }]
    const result = registration.listener({ url: 'https://example.com/', requestHeaders: headers })
    // Nothing was rewritten, so no header set is handed back at all.
    assert.equal(result, undefined)
    assert.deepEqual(headers, [{ name: 'Accept', value: '*/*' }])
  }
  assert.equal(consoleError.mock.callCount(), 0)
})

test('a listener called without details reports no modification', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'debug', () => {})
  const { registrations } = registerManifestV2Listeners()

  for (const registration of registrations) {
    assert.equal(registration.listener(), undefined)
  }
  assert.equal(consoleError.mock.callCount(), 0)
})

test('a partial rewrite is discarded when a later header cannot be written', (t) => {
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'debug', () => {})
  const { registrations } = registerManifestV2Listeners()

  for (const [host, rewrites] of [
    ['www.bing.com', bingHeaderRewrites],
    ['claude.ai', claudeHeaderRewrites],
  ]) {
    const headers = [
      { name: 'Origin', value: 'https://example.com' },
      Object.freeze({ name: 'Referer', value: 'https://example.com/page' }),
    ]
    const result = registrationFor(registrations, host).listener({
      url: `https://${host}/`,
      requestHeaders: headers,
    })
    // The rewrite happens in place, so the first header is already changed when
    // the second one throws. Returning nothing is what makes the browser keep
    // its own copy of the original header set instead of the partial one.
    assert.equal(result, undefined)
    assert.equal(headers[0].value, rewrites.origin)
    assert.equal(headers[1].value, 'https://example.com/page')
  }
})

test('listeners report no modification when requestHeaders is missing', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'debug', () => {})
  const { registrations } = registerManifestV2Listeners()

  for (const registration of registrations) {
    // Returning nothing means "leave the request unmodified", which is the
    // valid shape a blocking listener returns when it has no headers to
    // rewrite.
    assert.equal(registration.listener({ url: 'https://example.com/' }), undefined)
  }
  assert.equal(consoleError.mock.callCount(), 0)
})

test('only the Bing listener logs the modified header names', (t) => {
  const consoleDebug = t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'error', () => {})
  const { registrations } = registerManifestV2Listeners()

  const headers = [
    { name: 'Origin', value: 'https://example.com' },
    { name: 'Referer', value: 'https://example.com/page' },
  ]
  for (const registration of registrations) {
    registration.listener({
      url: 'https://example.com/',
      requestHeaders: structuredClone(headers),
    })
  }

  assert.equal(consoleDebug.mock.callCount(), 1)
  const loggedArguments = consoleDebug.mock.calls[0].arguments
  assert.equal(loggedArguments[0], '[background] Modified headers for Bing (names only):')
  assert.deepEqual(loggedArguments[1], ['Origin', 'Referer'])
  // Exactly the message and the header names: nothing else may be logged.
  assert.equal(loggedArguments.length, 2)
  const logged = JSON.stringify(loggedArguments)
  for (const value of ['https://example.com', 'https://example.com/page']) {
    assert.equal(logged.includes(value), false, `header value ${value} must not be logged`)
  }
})

test('listeners skip header entries without a name', (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'error', () => {})
  const { registrations } = registerManifestV2Listeners()

  for (const [host, rewrites] of [
    ['www.bing.com', bingHeaderRewrites],
    ['claude.ai', claudeHeaderRewrites],
  ]) {
    const result = registrationFor(registrations, host).listener({
      url: `https://${host}/`,
      requestHeaders: [null, { value: 'orphan' }, { name: 'Origin', value: 'https://example.com' }],
    })
    assert.deepEqual(result.requestHeaders, [
      null,
      { value: 'orphan' },
      { name: 'Origin', value: rewrites.origin },
    ])
  }
})

test('listeners report no modification when rewriting throws', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'debug', () => {})
  const { registrations } = registerManifestV2Listeners()

  for (const registration of registrations) {
    // A frozen header makes the in-place value assignment throw.
    const result = registration.listener({
      url: 'https://example.com/failing-rewrite',
      requestHeaders: [Object.freeze({ name: 'Origin', value: 'https://header-value.example' })],
    })
    assert.equal(result, undefined, 'a failed rewrite must leave the request untouched')
  }

  assert.equal(consoleError.mock.callCount(), registrations.length)
  for (const call of consoleError.mock.calls) {
    // String(argument) as well as JSON.stringify, because a value that only
    // reaches the log through an Error message would serialize as {}.
    const logged = call.arguments
      .map((argument) => `${JSON.stringify(argument)}${String(argument)}`)
      .join(' ')
    assert.ok(
      logged.includes('https://example.com/failing-rewrite'),
      'the request URL should be logged',
    )
    assert.equal(
      logged.includes('https://header-value.example'),
      false,
      'header values must not be logged',
    )
  }
})

test('manifest v2 relies on blocking listeners and manifest v3 on the DNR ruleset', () => {
  const manifestV2 = readSrcJson('../../../src/manifest.v2.json')
  const manifestV3 = readSrcJson('../../../src/manifest.json')

  assert.equal(manifestV2.manifest_version, 2)
  assert.ok(manifestV2.permissions.includes('webRequest'))
  assert.ok(manifestV2.permissions.includes('webRequestBlocking'))
  assert.equal(manifestV2.declarative_net_request, undefined)

  assert.equal(manifestV3.manifest_version, 3)
  // Without `webRequestBlocking` a manifest v3 listener could never rewrite a
  // header, which is the premise for skipping the JS listeners there, and
  // without a declarativeNetRequest permission the ruleset below would be inert.
  assert.equal(manifestV3.permissions.includes('webRequestBlocking'), false)
  assert.ok(
    manifestV3.permissions.some((permission) =>
      ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'].includes(permission),
    ),
  )
  const rulesets = manifestV3.declarative_net_request?.rule_resources ?? []
  assert.deepEqual(
    rulesets.map((ruleResource) => ruleResource.path),
    ['rules.json'],
  )
  assert.ok(rulesets.every((ruleResource) => ruleResource.enabled))
})

test('declarative rules keep the manifest v2 Bing and Claude rewrites in sync', () => {
  const rules = readSrcJson('../../../src/rules.json')
  const { registrations } = registerManifestV2Listeners()
  const bing = bingRegistration(registrations)
  const claude = claudeRegistration(registrations)

  const ruleFor = (hosts, resourceTypes) =>
    rules.find(
      (rule) =>
        Array.isArray(rule.condition?.requestDomains) &&
        Array.isArray(rule.condition?.resourceTypes) &&
        hosts.every((host) => rule.condition.requestDomains.includes(host)) &&
        resourceTypes.every((type) => rule.condition.resourceTypes.includes(type)),
    )

  const bingHosts = bing.filter.urls.map(hostFromUrlPattern)
  const claudeHosts = claude.filter.urls.map(hostFromUrlPattern)
  const bingRule = ruleFor(bingHosts, bing.filter.types)
  const claudeRule = ruleFor(claudeHosts, claude.filter.types)
  assert.ok(bingRule, 'a rules.json rule must cover every registered Bing host')
  assert.ok(claudeRule, 'a rules.json rule must cover every registered Claude host')
  assert.equal(bingRule.id, 1, 'rules.json must keep the Bing rule at id 1')
  assert.equal(claudeRule.id, 3, 'rules.json must keep the Claude rule at id 3')

  for (const [rule, registration] of [
    [bingRule, bing],
    [claudeRule, claude],
  ]) {
    const hosts = registration.filter.urls.map(hostFromUrlPattern)
    for (const domain of rule.condition.requestDomains) {
      assert.ok(
        hosts.includes(domain),
        `rule ${rule.id} covers ${domain}, which no manifest v2 listener filter matches`,
      )
    }
    for (const resourceType of rule.condition.resourceTypes) {
      assert.ok(
        registration.filter.types.includes(resourceType),
        `rule ${rule.id} covers ${resourceType}, which no manifest v2 listener filter matches`,
      )
    }
    // The DNR rules must stay domain-based: a filter, a method, an initiator, a
    // header condition, a top-level domain or an exclusion would narrow them
    // below the manifest v2 scheme and host set. The list is the narrowing half
    // of declarativeNetRequest.RuleCondition, as documented on MDN, plus the
    // top-level-domain conditions Chromium adds. Only
    // requestDomains and resourceTypes are the keys the listener filters are
    // compared against, so they are absent here by design.
    const narrowingConditions = [
      'urlFilter',
      'regexFilter',
      'isUrlFilterCaseSensitive',
      'requestMethods',
      'excludedRequestMethods',
      'domainType',
      'domains',
      'excludedDomains',
      'initiatorDomains',
      'excludedInitiatorDomains',
      'excludedRequestDomains',
      'excludedResourceTypes',
      'topDomains',
      'excludedTopDomains',
      'responseHeaders',
      'excludedResponseHeaders',
      'tabIds',
      'excludedTabIds',
    ]
    for (const key of narrowingConditions) {
      assert.equal(
        rule.condition[key],
        undefined,
        `rule ${rule.id} must not narrow its coverage with ${key}`,
      )
    }
  }

  const headerValueInRule = (rule, header) => {
    const entry = rule.action.requestHeaders.find((candidate) => candidate.header === header)
    // DNR's `set` operation applies the intended values and also adds absent
    // headers. These listeners only replace existing headers; that difference
    // is documented in webrequest-listeners.mjs and covered by the
    // "listeners neither touch nor add headers the request does not have" test.
    // The sync is deliberately partial: the chatgpt.com rule has no manifest v2
    // listener counterpart, because ChatGPT web requests run in a real tab that
    // already sends an acceptable Origin.
    assert.equal(entry?.operation, 'set')
    return entry?.value
  }

  for (const rule of [bingRule, claudeRule]) {
    assert.equal(rule.action.type, 'modifyHeaders')
    assert.deepEqual(
      rule.action.requestHeaders.map((entry) => entry.header).sort(),
      ['origin', 'referer'],
      `rule ${rule.id} must only rewrite Origin and Referer`,
    )
    assert.ok(
      rule.action.requestHeaders.every((entry) => entry.operation === 'set'),
      `rule ${rule.id} must only set headers`,
    )
  }

  assert.equal(headerValueInRule(bingRule, 'origin'), bingHeaderRewrites.origin)
  assert.equal(headerValueInRule(bingRule, 'referer'), bingHeaderRewrites.referer)
  assert.equal(headerValueInRule(claudeRule, 'origin'), claudeHeaderRewrites.origin)
  assert.equal(headerValueInRule(claudeRule, 'referer'), claudeHeaderRewrites.referer)
})

test('the background entry point routes header rewrites through the gated helper', () => {
  const backgroundSource = readFileSync(
    new URL('../../../src/background/index.mjs', import.meta.url),
    'utf8',
  )

  // Keep registration in the version-gated helper and pass the active version.
  assert.equal(backgroundSource.includes('Browser.webRequest.onBeforeSendHeaders'), false)
  const registrationPattern = new RegExp(
    String.raw`registerBlockingHeaderListeners\(\s*Browser\.webRequest,\s*` +
      String.raw`Browser\.runtime\.getManifest\(\)\.manifest_version,?\s*\)`,
  )
  assert.match(backgroundSource, registrationPattern)
})
