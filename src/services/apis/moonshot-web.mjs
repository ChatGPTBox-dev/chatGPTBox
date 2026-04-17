import { pushRecord, setAbortController } from './shared.mjs'
import { setUserConfig } from '../../config/index.mjs'
import { fetchSSE } from '../../utils/fetch-sse'
import { isEmpty } from 'lodash-es'
import { getModelValue } from '../../utils/model-name-convert.mjs'

export class MoonshotWeb {
  /**
   * If the moonshot client has initialized yet (call `init()` if you haven't and this is false)
   * @property {boolean}
   */
  ready
  /**
   * A proxy function/string to connect via
   * @property {({endpoint: string, options: Object}) => {endpoint: string, options: Object} | string}
   */
  proxy
  /**
   * A fetch function, defaults to globalThis.fetch
   * @property {Function}
   */
  fetch
  /**
   * @property {UserConfig}
   */
  config

  refreshToken

  accessToken

  /**
   * Create a new moonshot API client instance.
   * @param {Object} options - Options
   * @param {UserConfig} options.config
   * @param {function} [options.fetch] - Fetch function
   * @example
   * const moonshot = new moonshot({
   *   sessionKey: 'sk-ant-sid01-*****',
   *   fetch: globalThis.fetch
   * })
   *
   * await moonshot.init();
   * moonshot.sendMessage('Hello world').then(console.log)
   */
  constructor({ config, fetch }) {
    if (fetch) {
      this.fetch = fetch
    }
    this.config = config
    this.refreshToken = config.kimiMoonShotRefreshToken
    this.accessToken = config.kimiMoonShotAccessToken
  }
  /**
   * Get available models.
   * @returns {string[]} Array of model names
   */
  models() {
    return ['']
  }
  /**
   * Get the default model.
   * @returns {string} Default model name
   */
  defaultModel() {
    return this.models()[0]
  }

  /**
   * todo: mod
   * Send a message to a new or existing conversation.
   * @param {string} message - Initial message
   * @param {SendMessageParams} [params] - Additional parameters
   * @param {string} [params.conversation] - Existing conversation ID
   * @param {boolean} [params.temporary=true] - Delete after getting response
   * @returns {Promise<MessageStreamChunk>} Result message
   */
  async sendMessage(message, { conversation = null, temporary = true, ...params }) {
    if (!this.ready) {
      await this.init()
    }

    if (!conversation) {
      let out
      let convo = await this.startConversation(message, {
        ...params,
        done: (a) => {
          if (params.done) {
            params.done(a)
          }
          out = a
        },
      })
      if (temporary) {
        await convo.delete()
      }
      return out
    } else {
      return (await this.getConversation(conversation)).sendMessage(message, {
        ...params,
      })
    }
  }
  /**
   * Make an API request.
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Request options
   * @returns {Promise<Response>} Fetch response
   * @example
   * await a.request('/api/chat/cnor0teaofogidj025b0/completion/stream').then(r => r.json())
   */
  request(endpoint, options) {
    // Can't figure out a way to test this so I'm just assuming it works
    if (!(this.fetch || globalThis.fetch)) {
      throw new Error(
        `No fetch available in your environment. Use node-18 or later, a modern browser, or add the following code to your project:\n\nimport "isomorphic-fetch";\nconst moonshot = new moonshot({fetch: fetch, sessionKey: "sk-ant-sid01-*****"});`,
      )
    }
    if (!this.proxy) {
      this.proxy = ({ endpoint, options }) => ({
        endpoint: 'https://www.kimi.com' + endpoint,
        options,
      })
    }
    if (typeof this.proxy === 'string') {
      const HOST = this.proxy
      this.proxy = ({ endpoint, options }) => ({ endpoint: HOST + endpoint, options })
    }
    const proxied = this.proxy({ endpoint, options })
    return (this.fetch || globalThis.fetch)(proxied.endpoint, proxied.options)
  }
  /**
   * Initialize the client.
   * @async
   * @returns {Promise<void>} Void
   */
  async init() {
    const response = this.request('/api/user', {
      headers: {
        accept: '*/*',
        Authorization: `Bearer ${this.accessToken}`,
        Origin: 'https://www.kimi.com',
      },
      method: 'GET',
    })
    if ((await response).status === 200) {
      this.ready = true
    } else {
      const { access_token, refresh_token } = await this.request('/api/auth/token/refresh', {
        headers: {
          accept: '*/*',
          Authorization: `Bearer ${this.refreshToken}`,
          Origin: 'https://www.kimi.com',
        },
        method: 'GET',
      })
        .then((r) => r.json())
        .catch(errorHandle('get kimi.moonshoot.cn access_token'))
      this.accessToken = access_token
      this.refreshToken = refresh_token
      this.config.kimiMoonShotAccessToken = access_token
      this.config.kimiMoonShotRefreshToken = refresh_token
      await setUserConfig({
        kimiMoonShotAccessToken: access_token,
        kimiMoonShotRefreshToken: refresh_token,
      })
      this.ready = true
    }
  }

  /**
   * Start a new conversation
   * @param {String} message The message to send to start the conversation
   * @param {SendMessageParams} [params={}] Message params passed to Conversation.sendMessage
   * @returns {Promise<Conversation>}
   * @async
   * @example
   * const conversation = await moonshot.startConversation("Hello! How are you?")
   * console.log(await conversation.getInfo());
   */
  async startConversation(message, params = {}) {
    if (!this.ready) {
      await this.init()
    }
    const { id, name, created_at } = await this.request('/api/chat', {
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        Origin: 'https://www.kimi.com',
      },
      method: 'POST',
      signal: params.signal,
      body: JSON.stringify({ name: '未命名会话', is_example: false }),
    })
      .then((r) => r.json())
      .catch(errorHandle('startConversation create'))
    const convo = new Conversation(this, {
      conversationId: id,
      name,
      created_at,
    })
    await convo.sendMessage(message, params)
    return convo
  }
  /**
   * Get a conversation by its ID
   * @param {UUID} id The uuid of the conversation (Conversation.uuid or Conversation.conversationId)
   * @async
   * @returns {Conversation | null} The conversation
   * @example
   * const conversation = await moonshot.getConversation("222aa20a-bc79-48d2-8f6d-c819a1b5eaed");
   */
  async getConversation(id) {
    if (id instanceof Conversation || id.conversationId) {
      return new Conversation(this, { conversationId: id.conversationId })
    }
    return new Conversation(this, { conversationId: id })
  }
}

/**
 * @typedef SendMessageParams
 * @property {Boolean} [retry=false] Whether to retry the most recent message in the conversation instead of sending a new one
 * @property {String} [timezone="America/New_York"] The timezone
 * @property {Attachment[]} [attachments=[]] Attachments
 * @property {doneCallback} [done] Callback when done receiving the message response
 * @property {progressCallback} [progress] Callback on message response progress
 * @property {string} [model=moonshot.defaultModel()] The model to use
 */
/**
 * A moonshot conversation instance.
 * @class
 * @typedef Conversation
 * @classdesc Represents an active moonshot conversation.
 */
export class Conversation {
  /**
   * The conversation ID
   * @property {string}
   */
  conversationId

  /**
   * The conversation name
   * @property {string}
   */
  name

  /**
   * The conversation summary (usually empty)
   * @property {string}
   */
  summary

  /**
   * The conversation created at
   * @property {string}
   */
  created_at

  /**
   * The conversation updated at
   * @property {string}
   */
  updated_at

  /**
   * The request function (from parent moonshot instance)
   * @property {(url: string, options: object) => Response}
   */
  request

  /**
   * The current model
   * @property {string}
   */
  model

  /**
   * If the moonshot client has initialized yet (call `init()` if you haven't and this is false)
   * @property {boolean}
   */
  ready

  /**
   * A proxy function/string to connect via
   * @property {({endpoint: string, options: Object}) => {endpoint: string, options: Object} | string}
   */
  proxy

  /**
   * A fetch function, defaults to globalThis.fetch
   * @property {Function}
   */
  fetch
  /**
   * Create a Conversation instance.
   * @param {MoonshotWeb} moonshot - moonshot client instance
   * @param {Object} options - Options
   * @param {String} options.conversationId - Conversation ID
   * @param {String} [options.name] - Conversation name
   * @param {String} [options.summary] - Conversation summary
   * @param {String} [options.created_at] - Conversation created at
   * @param {String} [options.updated_at] - Conversation updated at
   * @param {String} [options.model] - moonshot model
   */
  constructor(
    moonshot,
    { model = 'default', conversationId, name = '', summary = '', created_at, updated_at },
  ) {
    this.moonshot = moonshot
    this.conversationId = conversationId
    this.request = moonshot.request
    if (!this.moonshot) {
      throw new Error('moonshot not initialized')
    }
    if (!this.moonshot.refreshToken) {
      throw new Error(
        'moonshot token required, please login at https://kimi.com first, and then click the retry button',
      )
    }
    if (!this.conversationId) {
      throw new Error('Conversation ID required, are you calling `await moonshot.init()`?')
    }
    if (model === 'default') {
      model = this.moonshot.defaultModel()
    }
    this.model = model || this.moonshot.defaultModel()
    Object.assign(this, {
      name,
      summary,
      created_at: created_at || new Date().toISOString(),
      updated_at: updated_at || new Date().toISOString(),
    })
  }
  /**
   * Convert the conversation to a JSON object
   * @returns {Conversation} The serializable object
   */
  toJSON() {
    return {
      conversationId: this.conversationId,
      name: this.name,
      summary: this.summary,
      created_at: this.created_at,
      updated_at: this.updated_at,
      model: this.model,
    }
  }
  /**
   * Retry the last message in the conversation
   * @param {SendMessageParams} [params={}]
   * @returns {Promise<MessageStreamChunk>}
   */
  async retry(params) {
    return this.sendMessage('', { ...params, retry: true })
  }
  /**
   * Send a message to this conversation
   * @param {String} message
   * @async
   * @param {SendMessageParams} params The parameters to send along with the message
   * @returns {Promise<MessageStreamChunk>}
   */
  async sendMessage(
    message,
    {
      // eslint-disable-next-line no-unused-vars
      retry = false,
      model = 'k2',
      done = () => {},
      progress = () => {},
      // eslint-disable-next-line no-unused-vars
      rawResponse = () => {},
      signal = null,
    } = {},
  ) {
    // {"messages":[{"role":"user","content":"hello"}],"refs":[],"use_search":true}
    const body = {
      kimiplus_id: 'kimi',
      messages: [{ role: 'user', content: message }],
      model,
      refs: [],
      use_search: true,
      use_deep_research: false,
      use_semantic_memory: false,
    }
    let resolve, reject
    let returnPromise = new Promise((r, j) => {
      resolve = r
      reject = j
    })
    let fullResponse = ''
    await fetchSSE(`https://www.kimi.com/api/chat/${this.conversationId}/completion/stream`, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        Authorization: `Bearer ${this.moonshot.accessToken}`,
      },
      signal: signal,
      body: JSON.stringify(body),
      onMessage(message) {
        console.debug('sse message', message)
        let parsed
        try {
          parsed = JSON.parse(message)
        } catch (error) {
          console.debug('json error', error)
          return
        }
        if (parsed.error) {
          throw new Error(message)
        }
        if (parsed.event === 'cmpl' && parsed.text) fullResponse += parsed.text
        const PROGRESS_OBJECT = {
          ...parsed,
          completion: fullResponse,
          delta: parsed.text || '',
        }
        progress(PROGRESS_OBJECT)
        if (parsed.event === 'all_done') {
          done(PROGRESS_OBJECT)
          resolve(PROGRESS_OBJECT)
        }
      },
      async onStart() {},
      async onEnd() {
        resolve({
          completion: fullResponse,
        })
      },
      async onError(resp) {
        if (resp instanceof Error) {
          reject(resp)
          return
        }
        const error = await resp.json().catch(() => ({}))
        reject(
          new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`),
        )
      },
    })
    return returnPromise
  }

  /**
   * Delete the conversation
   * @async
   * @returns Promise<Response>
   */
  async delete() {
    return await this.request(`/api/chat/chat_conversations/${this.conversationId}`, {
      headers: {
        accept: '*/*',
        Authorization: `Bearer ${this.moonshot.accessToken}`,
        Origin: 'https://www.kimi.com',
      },
      method: 'DELETE',
    }).catch(errorHandle('Delete conversation ' + this.conversationId))
  }

  /**
   * Get all messages in the conversation
   * @async
   * @returns {Promise<Message[]>}
   */
  getMessages() {
    return this.getInfo()
      .then((a) => a.chat_messages)
      .catch(errorHandle('getMessages'))
  }
}

/**
 * A function that handles errors.
 *
 * @param {string} msg - The error message.
 * @return {function} - A function that logs the error message and exits the process.
 */
function errorHandle(msg) {
  return (e) => {
    console.error(`Error at: ${msg}`)
    console.error(e)
    // process.exit(0)
  }
}

/**
 * @typedef JSONResponse
 * @property {'human' | 'assistant'} sender The sender
 * @property {string} text The text
 * @property {UUID} uuid msg uuid
 * @property {string} created_at The message created at
 * @property {string} updated_at The message updated at
 * @property {string} edited_at When the message was last edited (no editing support via api/web client)
 * @property {Attachment[]} attachments The attachments
 * @property {string} chat_feedback Feedback
 */
/**
 * Message class
 * @class
 * @classdesc A class representing a message in a Conversation
 * @property {Function} request The request function  (inherited from moonshot instance)
 * @property {JSONResponse} json The JSON representation
 * @property {moonshot} moonshot The moonshot instance
 * @property {Conversation} conversation The conversation this message belongs to
 * @property {UUID} uuid The message uuid
 */
export class Message {
  /**
   * Create a Message instance.
   * @param {Object} params - Params
   * @param {Conversation} params.conversation - Conversation instance
   * @param {moonshot} params.moonshot - moonshot instance
   * @param {Message} message - Message data
   */
  constructor(
    { conversation, moonshot },
    { uuid, text, sender, index, updated_at, edited_at, chat_feedback, attachments },
  ) {
    if (!moonshot) {
      throw new Error('moonshot not initialized')
    }
    if (!conversation) {
      throw new Error('Conversation not initialized')
    }
    Object.assign(this, { conversation, moonshot })
    this.request = moonshot.request
    this.json = { uuid, text, sender, index, updated_at, edited_at, chat_feedback, attachments }
    Object.assign(this, this.json)
  }
  /**
   * Convert this message to a JSON representation
   * Necessary to prevent circular JSON errors
   * @returns {Message}
   */
  toJSON() {
    return this.json
  }
  /**
   * Returns the value of the "created_at" property as a Date object.
   *
   * @return {Date} The value of the "created_at" property as a Date object.
   */
  get createdAt() {
    return new Date(this.json.created_at)
  }
  /**
   * Returns the value of the "updated_at" property as a Date object.
   *
   * @return {Date} The value of the "updated_at" property as a Date object.
   */
  get updatedAt() {
    return new Date(this.json.updated_at)
  }
  /**
   * Returns the value of the "edited_at" property as a Date object.
   *
   * @return {Date} The value of the "edited_at" property as a Date object.
   */
  get editedAt() {
    return new Date(this.json.edited_at)
  }
  /**
   * Get if message is from the assistant.
   * @type {boolean}
   */
  get isBot() {
    return this.sender === 'assistant'
  }
}

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {UserConfig} config
 */
export async function generateAnswersWithMoonshotWebApi(port, question, session, config) {
  const bot = new MoonshotWeb({ config })
  await bot.init()
  const { controller, cleanController } = setAbortController(port)
  const model = getModelValue(session)

  let answer = ''
  const progressFunc = ({ completion }) => {
    answer = completion
    port.postMessage({ answer: answer, done: false, session: null })
  }

  const doneFunc = () => {
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    port.postMessage({ answer: answer, done: true, session: session })
  }

  const params = {
    progress: progressFunc,
    done: doneFunc,
    model,
    signal: controller.signal,
  }

  if (!session.moonshot_conversation)
    await bot
      .startConversation(question, params)
      .then((conversation) => {
        conversation.request = null
        conversation.moonshot = null
        session.moonshot_conversation = conversation
        port.postMessage({ answer: answer, done: true, session: session })
        cleanController()
      })
      .catch((err) => {
        cleanController()
        throw err
      })
  else
    await bot
      .sendMessage(question, {
        conversation: session.moonshot_conversation,
        ...params,
      })
      .then(cleanController)
      .catch((err) => {
        cleanController()
        throw err
      })
}
