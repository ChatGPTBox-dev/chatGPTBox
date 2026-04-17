// https://github.com/Explosion-Scratch/claude-unofficial-api
/* eslint-disable */

import { fetchSSE } from '../../../utils/fetch-sse'
import { isEmpty } from 'lodash-es'

/**
 * The main Claude API client class.
 * @typedef Claude
 * @class
 * @classdesc Creates an instance of the Claude API client.
 */
export class Claude {
  /**
   * If the Claude client has initialized yet (call `init()` if you haven't and this is false)
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
   * The session key string (from the cookie)
   * @property {string}
   */
  sessionKey
  /**
   * A UUID string
   * @typedef UUID
   * @example "222aa20a-bc79-48d2-8f6d-c819a1b5eaed"
   */
  /**
   * Create a new Claude API client instance.
   * @param {Object} options - Options
   * @param {string} options.sessionKey - Claude session key
   * @param {string|function} [options.proxy] - Proxy URL or proxy function
   * @param {function} [options.fetch] - Fetch function
   * @example
   * const claude = new Claude({
   *   sessionKey: 'sk-ant-sid01-*****',
   *   fetch: globalThis.fetch
   * })
   *
   * await claude.init();
   * claude.sendMessage('Hello world').then(console.log)
   */
  constructor({ sessionKey, proxy, fetch }) {
    this.ready = false
    if (typeof proxy === 'string') {
      const HOST = proxy
      this.proxy = ({ endpoint, options }) => ({ endpoint: HOST + endpoint, options })
    } else if (typeof proxy === 'function') {
      this.proxy = proxy
    } else if (proxy) {
      console.log(
        'Proxy supported formats:\n\t({ endpoint /* endpoint (path) */, options /* fetch options */ }) => { endpoint /* full url */, options /* fetch options */ }',
      )
      console.log('Received proxy: ' + proxy)
      throw new Error('Proxy must be a string (host) or a function')
    }
    if (!this.proxy) {
      this.proxy = ({ endpoint, options }) => ({
        endpoint: 'https://claude.ai' + endpoint,
        options,
      })
    }
    if (!sessionKey) {
      throw new Error('Session key required')
    }
    if (!sessionKey.startsWith('sk-ant-sid01')) {
      throw new Error('Session key invalid: Must be in the format sk-ant-sid01-*****')
    }
    if (fetch) {
      this.fetch = fetch
    }
    this.sessionKey = sessionKey
  }
  /**
   * Get available Claude models.
   * @returns {string[]} Array of model names
   */
  models() {
    return ['claude-2', 'claude-1.3', 'claude-instant', 'claude-instant-100k']
  }
  /**
   * Get total token count for a Claude model.
   * @param {string} [model] - Claude model name
   * @returns {number} Total token count
   */
  totalTokens(model) {
    // TODO: Figure out if this is correct, the blog article said "We’ve expanded Claude’s context window from 9K to 100K tokens"
    const TOKENS = {
      'claude-2': 100_000,
      'claude-1.3': 9000,
      'claude-instant': 9000,
      'claude-instant-100k': 100_000,
    }
    return TOKENS[model || this.defaultModel()]
  }
  /**
   * Get the default Claude model.
   * @returns {string} Default model name
   */
  defaultModel() {
    return this.models()[0]
  }
  /**
   * A partial or total completion for a message.
   * @typedef MessageStreamChunk
   * @property {String} completion The markdown text completion for this response
   * @property {String | null} stop_reason The reason for the response stop (if any)
   * @property {String} model The model used
   * @property {String} stop The string at which Claude stopped responding at, e.g. "\n\nHuman:"
   * @property {String} log_id A logging ID
   * @property {Object} messageLimit If you're within the message limit
   * @param {String} messageLimit.type The type of message limit ("within_limit")
   */
  /**
   * Send a message to a new or existing conversation.
   * @param {string} message - Initial message
   * @param {SendMessageParams} [params] - Additional parameters
   * @param {string} [params.conversation] - Existing conversation ID
   * @param {boolean} [params.temporary=true] - Delete after getting response
   * @returns {Promise<MessageStreamChunk>} Result message
   */
  async sendMessage(message, { conversation = null, temporary = true, ...params }) {
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
   * await claude.request('/api/organizations').then(r => r.json())
   */
  request(endpoint, options) {
    // Can't figure out a way to test this so I'm just assuming it works
    if (!(this.fetch || globalThis.fetch)) {
      throw new Error(
        `No fetch available in your environment. Use node-18 or later, a modern browser, or add the following code to your project:\n\nimport "isomorphic-fetch";\nconst claude = new Claude({fetch: fetch, sessionKey: "sk-ant-sid01-*****"});`,
      )
    }
    if (!this.proxy) {
      this.proxy = ({ endpoint, options }) => ({
        endpoint: 'https://claude.ai' + endpoint,
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
    const organizations = await this.getOrganizations()
    if (organizations.error) {
      throw new Error(organizations.error)
    }
    this.organizationId = organizations[0].uuid
    this.recent_conversations = await this.getConversations()
    this.ready = true
  }
  /**
   * An organization
   * @typedef Organization
   * @property {String} join_token A token
   * @property {String} name The organization name
   * @property {String} uuid The organization UUID
   * @property {String} created_at The organization creation date
   * @property {String} updated_at The organization update date
   * @property {String[]} capabilities What the organization can do
   * @property {Object} settings The organization's settings
   * @property {Array} active_flags Organization's flags (none that I've found)
   */
  /**
   * Get the organizations list.
   * @async
   * @returns {Promise<Organization[]>} A list of organizations
   * @example
   * await claude.getOrganizations().then(organizations => {
   *  console.log('Users organization name is:', organizations[0].name)
   * })
   */
  async getOrganizations() {
    const response = await this.request('/api/organizations', {
      headers: {
        'content-type': 'application/json',
        cookie: `sessionKey=${this.sessionKey}`,
      },
    })
    const responseText = await response.text()
    if (responseText.includes('available in certain regions'))
      return {
        error: 'Claude.ai is not available in your region',
      }
    try {
      return JSON.parse(responseText)
    } catch (e) {
      errorHandle('getOrganizations')(e)
      return {
        error: 'failed to parse response',
      }
    }
  }
  /**
   * Delete all conversations
   * @async
   * @returns {Promise<Response[]>} An array of responses for the DELETE requests
   * @example
   * await claude.clearConversations();
   * console.assert(await claude.getConversations().length === 0);
   */
  async clearConversations() {
    const convos = await this.getConversations()
    return Promise.all(convos.map((i) => i.delete()))
  }
  /**
   * @callback doneCallback
   * @param {MessageStreamChunk} a The completed response
   */
  /**
   * @callback progressCallback
   * @param {MessageStreamChunk} a The response in progress
   */
  /**
   * Start a new conversation
   * @param {String} message The message to send to start the conversation
   * @param {SendMessageParams} [params={}] Message params passed to Conversation.sendMessage
   * @returns {Promise<Conversation>}
   * @async
   * @example
   * const conversation = await claude.startConversation("Hello! How are you?")
   * console.log(await conversation.getInfo());
   */
  async startConversation(message, params = {}) {
    if (!this.ready) {
      await this.init()
    }
    const {
      uuid: convoID,
      name,
      summary,
      created_at,
      updated_at,
    } = await this.request(`/api/organizations/${this.organizationId}/chat_conversations`, {
      headers: {
        'content-type': 'application/json',
        cookie: `sessionKey=${this.sessionKey}`,
      },
      method: 'POST',
      signal: params.signal,
      body: JSON.stringify({
        name: '',
        uuid: uuid(),
      }),
    })
      .then((r) => r.json())
      .catch(errorHandle('startConversation create'))
    const convo = new Conversation(this, {
      conversationId: convoID,
      name,
      summary,
      created_at,
      updated_at,
    })
    await convo.sendMessage(message, params)
    await this.request(
      `/api/organizations/${this.organizationId}/chat_conversations/${convoID}/title`,
      {
        headers: {
          'content-type': 'application/json',
          cookie: `sessionKey=${this.sessionKey}`,
        },
        body: JSON.stringify({
          message_content: message,
          recent_titles: this.recent_conversations.map((i) => i.name),
        }),
        method: 'POST',
      },
    )
      .then((r) => r.json())
      .catch(errorHandle('startConversation generate_chat_title'))
    return convo
  }
  /**
   * Get a conversation by its ID
   * @param {UUID} id The uuid of the conversation (Conversation.uuid or Conversation.conversationId)
   * @async
   * @returns {Conversation | null} The conversation
   * @example
   * const conversation = await claude.getConversation("222aa20a-bc79-48d2-8f6d-c819a1b5eaed");
   */
  async getConversation(id) {
    if (id instanceof Conversation || id.conversationId) {
      return new Conversation(this, { conversationId: id.conversationId })
    }
    return new Conversation(this, { conversationId: id })
  }
  /**
   * Get all conversations
   * @async
   * @returns {Promise<Conversation[]>} A list of conversations
   * @example
   * console.log(`You have ${await claude.getConversations().length} conversations:`);
   */
  async getConversations() {
    const response = await this.request(
      `/api/organizations/${this.organizationId}/chat_conversations`,
      {
        headers: {
          'content-type': 'application/json',
          cookie: `sessionKey=${this.sessionKey}`,
        },
      },
    )
    const json = await response.json()
    return json.map((convo) => new Conversation(this, { conversationId: convo.uuid, ...convo }))
  }
  /**
   * The response from uploading a file (an attachment)
   * @typedef Attachment
   * @property {String} file_name The file name
   * @property {String} file_type The file's mime type
   * @property {Number} file_size The file size in bytes
   * @property {String} extracted_content The contents of the file that were extracted
   * @property {Number | null} [totalPages] The total pages of the document
   */
  /**
   * Extract the contents of a file
   * @param {File} file A JS File (like) object to upload.
   * @async
   * @returns {Promise<Attachment>}
   * @example
   * const file = await claude.uploadFile(
   *     new File(["test"], "test.txt", { type: "text/plain" }
   * );
   * console.log(await claude.sendMessage("What's the contents of test.txt?", {
   *  attachments: [file]
   * }))
   */
  async uploadFile(file) {
    const { content, isText } = await readAsText(file)
    if (isText) {
      console.log(`Extracted ${content.length} characters from ${file.name}`)
      return {
        file_name: file.name,
        file_type: file.type,
        file_size: file.size,
        extracted_content: content,
      }
    }
    const fd = new FormData()
    fd.append('file', file, file.name)
    fd.append('orgUuid', this.organizationId)
    const response = await this.request('/api/convert_document', {
      headers: {
        cookie: `sessionKey=${this.sessionKey}`,
      },
      method: 'POST',
      body: fd,
    })
    let json
    try {
      json = await response.json()
    } catch (e) {
      console.log("Couldn't parse JSON", response.status)
      throw new Error('Invalid response when uploading ' + file.name)
    }
    if (response.status !== 200) {
      console.log('Status not 200')
      throw new Error('Invalid response when uploading ' + file.name)
    }
    if (!json.hasOwnProperty('extracted_content')) {
      console.log(json)
      throw new Error('Invalid response when uploading ' + file.name)
    }
    console.log(`Extracted ${json.extracted_content.length} characters from ${file.name}`)
    return json
  }
}

/**
 * @typedef SendMessageParams
 * @property {Boolean} [retry=false] Whether to retry the most recent message in the conversation instead of sending a new one
 * @property {String} [timezone="America/New_York"] The timezone
 * @property {Attachment[]} [attachments=[]] Attachments
 * @property {doneCallback} [done] Callback when done receiving the message response
 * @property {progressCallback} [progress] Callback on message response progress
 * @property {string} [model=claude.defaultModel()] The model to use
 */
/**
 * A Claude conversation instance.
 * @class
 * @typedef Conversation
 * @classdesc Represents an active Claude conversation.
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
   * The Claude client
   * @property {Claude}
   */
  claude

  /**
   * The request function (from parent claude instance)
   * @property {(url: string, options: object) => Response}
   */
  request

  /**
   * The current model
   * @property {string}
   */
  model

  /**
   * If the Claude client has initialized yet (call `init()` if you haven't and this is false)
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
   * @param {Claude} claude - Claude client instance
   * @param {Object} options - Options
   * @param {String} options.conversationId - Conversation ID
   * @param {String} [options.name] - Conversation name
   * @param {String} [options.summary] - Conversation summary
   * @param {String} [options.created_at] - Conversation created at
   * @param {String} [options.updated_at] - Conversation updated at
   * @param {String} [options.model] - Claude model
   */
  constructor(
    claude,
    { model = 'default', conversationId, name = '', summary = '', created_at, updated_at },
  ) {
    this.claude = claude
    this.conversationId = conversationId
    this.request = claude.request
    if (!this.claude) {
      throw new Error('Claude not initialized')
    }
    if (!this.claude.sessionKey) {
      throw new Error('Session key required')
    }
    if (!this.conversationId) {
      throw new Error('Conversation ID required, are you calling `await claude.init()`?')
    }
    if (model === 'default') {
      model = this.claude.defaultModel()
    }
    this.model = model || this.claude.defaultModel()
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
      uuid: this.conversationId,
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
      retry = false,
      timezone = 'America/New_York',
      attachments = [],
      model = 'default',
      done = () => {},
      progress = () => {},
      rawResponse = () => {},
      signal = null,
    } = {},
  ) {
    if (model === 'default') {
      model = this.claude.defaultModel()
    }
    const body = {
      prompt: message,
      attachments,
      timezone,
    }
    let resolve, reject
    let returnPromise = new Promise((r, j) => {
      resolve = r
      reject = j
    })
    let fullResponse = ''
    await fetchSSE(
      `https://claude.ai/api/organizations/${this.claude.organizationId}/chat_conversations/${
        this.conversationId
      }/${retry ? 'retry_completion' : 'completion'}`,
      {
        method: 'POST',
        headers: {
          accept: 'text/event-stream,text/event-stream',
          'content-type': 'application/json',
          cookie: `sessionKey=${this.claude.sessionKey}`,
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
          if (parsed.completion) fullResponse += parsed.completion
          const PROGRESS_OBJECT = {
            ...parsed,
            completion: fullResponse,
            delta: parsed.completion || '',
          }
          progress(PROGRESS_OBJECT)
          if (parsed.stop_reason === 'stop_sequence') {
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
            new Error(
              !isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`,
            ),
          )
        },
      },
    )
    return returnPromise
  }
  /**
   * Rename the current conversation
   * @async
   * @param {String} title The new title
   * @returns {Promise<Response>} A Response object
   */
  async rename(title) {
    if (!title?.length) {
      throw new Error('Title required')
    }
    return await this.request('/api/rename_chat', {
      method: 'POST',
      headers: {
        cookie: `sessionKey=${this.claude.sessionKey}`,
      },
      body: JSON.stringify({
        conversation_uuid: this.conversationId,
        organization_uuid: this.claude.organizationId,
        title,
      }),
    }).catch(errorHandle('Rename conversation ' + this.conversationId))
  }
  /**
   * Delete the conversation
   * @async
   * @returns Promise<Response>
   */
  async delete() {
    return await this.request(
      `/api/organizations/${this.claude.organizationId}/chat_conversations/${this.conversationId}`,
      {
        headers: {
          cookie: `sessionKey=${this.claude.sessionKey}`,
        },
        method: 'DELETE',
      },
    ).catch(errorHandle('Delete conversation ' + this.conversationId))
  }
  /**
   * @typedef Message
   * @property {UUID} uuid The message UUID
   * @property {String} text The message text
   * @property {String} created_at The message created at
   * @property {String} updated_at The message updated at
   * @property {String | null} edited_at When the message was last edited (no editing support via api/web client)
   * @property {Any | null} chat_feedback Feedback
   * @property {Attachment[]} attachments The attachments
   */
  /**
   * @typedef ConversationInfo
   * @extends Conversation
   * @property {Message[]} chat_messages The messages in this conversation
   */
  /**
   * Get information about this conversation
   * @returns {Promise<ConversationInfo>}
   */
  async getInfo() {
    const response = await this.request(
      `/api/organizations/${this.claude.organizationId}/chat_conversations/${this.conversationId}`,
      {
        headers: {
          'content-type': 'application/json',
          cookie: `sessionKey=${this.claude.sessionKey}`,
        },
      },
    )
    return await response
      .json()
      .then(this.#formatMessages('chat_messages'))
      .catch(errorHandle('getInfo'))
  }
  /**
   * Get all the files from this conversation
   * @async
   * @returns {Promise<Attachment[]>}
   */
  getFiles() {
    return this.getMessages()
      .then((r) => r.map((i) => i.attachments))
      .then((r) => r.flat())
      .catch(errorHandle('getFiles'))
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
  /**
   * Internal method for converting a JSON response to contain Message objects
   * @param {String} message_key The message key in the object
   * @returns {Function}
   */
  #formatMessages(message_key) {
    return (response) => {
      if (!response[message_key]) {
        return response
      }
      return {
        ...response,
        [message_key]: response[message_key].map(
          (i) => new Message({ claude: this.claude, conversation: this }, { ...i }),
        ),
      }
    }
  }
}

/**
 * Reads a stream and returns the decoded data as a string.
 *
 * @param {Response} response - The response object containing the stream.
 * @param {function} progressCallback - A callback function to track the progress of reading the stream.
 * @return {Promise<string>} - A promise that resolves with the decoded data as a string.
 */
async function readStream(response, progressCallback) {
  const reader = response.body.getReader()
  let received = 0
  let chunks = []
  let loading = true
  while (loading) {
    const { done, value } = await reader.read()
    if (done) {
      loading = false
      break
    }
    chunks.push(value)
    received += value?.length || 0

    let full = new Uint8Array(received)
    let position = 0

    for (let chunk of chunks) {
      full.set(chunk, position)
      position += chunk.length
    }

    if (value) {
      progressCallback(
        new TextDecoder('utf-8').decode(value),
        new TextDecoder('utf-8').decode(full),
      )
    }
  }

  let body = new Uint8Array(received)
  let position = 0

  for (let chunk of chunks) {
    body.set(chunk, position)
    position += chunk.length
  }

  return new TextDecoder('utf-8').decode(body)
}

/**
 * Reads the contents of a file as text.
 *
 * @param {File} file - The file object to read.
 * @return {Object} - An object containing the content of the file and a flag indicating if it is a text file.
 */
async function readAsText(file) {
  const buf = await file.arrayBuffer()
  // const allow = ['text', 'javascript', 'json', 'html', 'sh', 'xml', 'latex', 'ecmascript']
  const notText = ['doc', 'pdf', 'ppt', 'xls']
  return {
    content: new TextDecoder('utf-8').decode(buf),
    isText: !notText.find((i) => file.name.includes(i)),
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
 * Generates a random UUID.
 *
 * @return {UUID} A randomly generated UUID.
 */
function uuid() {
  var h = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f']
  var k = [
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    '-',
    'x',
    'x',
    'x',
    'x',
    '-',
    '4',
    'x',
    'x',
    'x',
    '-',
    'y',
    'x',
    'x',
    'x',
    '-',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
    'x',
  ]
  var u = '',
    i = 0,
    rb = (Math.random() * 0xffffffff) | 0
  while (i++ < 36) {
    var c = k[i - 1],
      r = rb & 0xf,
      v = c == 'x' ? r : (r & 0x3) | 0x8
    u += c == '-' || c == '4' ? c : h[v]
    rb = i % 8 == 0 ? (Math.random() * 0xffffffff) | 0 : rb >> 4
  }
  return u
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
 * @property {Function} request The request function  (inherited from claude instance)
 * @property {JSONResponse} json The JSON representation
 * @property {Claude} claude The claude instance
 * @property {Conversation} conversation The conversation this message belongs to
 * @property {UUID} uuid The message uuid
 */
export class Message {
  /**
   * Create a Message instance.
   * @param {Object} params - Params
   * @param {Conversation} params.conversation - Conversation instance
   * @param {Claude} params.claude - Claude instance
   * @param {Message} message - Message data
   */
  constructor(
    { conversation, claude },
    { uuid, text, sender, index, updated_at, edited_at, chat_feedback, attachments },
  ) {
    if (!claude) {
      throw new Error('Claude not initialized')
    }
    if (!conversation) {
      throw new Error('Conversation not initialized')
    }
    Object.assign(this, { conversation, claude })
    this.request = claude.request
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
  /**
   * @typedef MessageFeedback
   * @property {UUID} uuid - Message UUID
   * @property {"flag/bug" | "flag/harmful" | "flag/other"} type - Feedback type
   * @property {String | null} reason - Feedback reason (details box)
   * @property {String} created_at - Feedback creation date
   * @property {String} updated_at - Feedback update date
   */
  /**
   * Send feedback on the message.
   * @param {string} type - Feedback type
   * @param {string} [reason] - Feedback reason
   * @returns {Promise<MessageFeedback>} Response
   */
  async sendFeedback(type, reason = '') {
    const FEEDBACK_TYPES = ['flag/bug', 'flag/harmful', 'flag/other']
    if (!FEEDBACK_TYPES.includes(type)) {
      throw new Error('Invalid feedback type, must be one of: ' + FEEDBACK_TYPES.join(', '))
    }
    return await this.request(
      `/api/organizations/${this.claude.organizationId}/chat_conversations/${this.conversation.conversationId}/chat_messages/${this.uuid}/chat_feedback`,
      {
        headers: {
          cookie: `sessionKey=${this.claude.sessionKey}`,
        },
        body: JSON.stringify({
          type,
          reason,
        }),
        method: 'POST',
      },
    ).catch(errorHandle('Send feedback'))
  }
}

export default Claude
/* eslint-enable */
