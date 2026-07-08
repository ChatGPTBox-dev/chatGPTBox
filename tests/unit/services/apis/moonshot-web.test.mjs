import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MoonshotWeb } from '../../../../src/services/apis/moonshot-web.mjs'

test('MoonshotWeb.init forwards its signal to user and refresh requests', async () => {
  const controller = new AbortController()
  const requests = []
  const config = {
    kimiMoonShotAccessToken: 'old-access-token',
    kimiMoonShotRefreshToken: 'old-refresh-token',
  }
  const bot = new MoonshotWeb({
    config,
    fetch: async (endpoint, options) => {
      requests.push({ endpoint, options })
      if (endpoint.endsWith('/api/user')) return { status: 401 }
      return {
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
        }),
      }
    },
  })

  await bot.init(controller.signal)

  assert.deepEqual(
    requests.map(({ endpoint }) => endpoint),
    ['https://www.kimi.com/api/user', 'https://www.kimi.com/api/auth/token/refresh'],
  )
  assert.equal(
    requests.every(({ options }) => options.signal === controller.signal),
    true,
  )
})
