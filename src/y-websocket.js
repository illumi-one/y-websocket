/**
 * @module provider/websocket
 */

/* eslint-env browser */

import * as Y from 'yjs' // eslint-disable-line
import * as bc from 'lib0/broadcastchannel'
import * as time from 'lib0/time'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as authProtocol from 'y-protocols/auth'
import * as awarenessProtocol from 'y-protocols/awareness'
import { Observable } from 'lib0/observable'
import * as math from 'lib0/math'
import * as url from 'lib0/url'
import * as env from 'lib0/environment'
import log from "loglevel";

export const messageSync = 0
export const messageQueryAwareness = 3
export const messageAwareness = 1
export const messageAuth = 2

export const YWebsocketLoggerName = "YWebsocketProviderLogger"
export const YWebsocketAwarenessLoggerName = "YWebsocketProviderAwarenessLogger"
export const YWebsocketSyncLoggerName = "YWebsocketProviderSyncLogger"
const logger = log.getLogger(YWebsocketLoggerName)
const alogger = log.getLogger(YWebsocketAwarenessLoggerName)
const slogger = log.getLogger(YWebsocketSyncLoggerName)

/**
 *                       encoder,          decoder,          provider,          emitSynced, messageType
 * @type {Array<function(encoding.Encoder, decoding.Decoder, WebsocketProvider, boolean,    number):void>}
 */
const messageHandlers = []

messageHandlers[messageSync] = (
  encoder,
  decoder,
  provider,
  emitSynced,
  _messageType
) => {
  const docGuid = decoding.readVarString(decoder)
  const doc = provider.getDoc(docGuid)
  if (!doc) {
    console.error('sync: doc not found with id: ', docGuid)
    return
  }
  encoding.writeVarUint(encoder, messageSync)
  encoding.writeVarString(encoder, docGuid)
  logger.debug(`syncing doc: ${docGuid}, decoder size ${decoder.arr.length}, position ${decoder.pos}`)
  
  //additional logic inside - will read the state vector from the decoder, understand the diff in the doc and 
  //write reply to the encoder with step 1/2 depending of sync message in decoder first byte
  const syncMessageType = syncProtocol.readSyncMessage(
    decoder,
    encoder,
    doc,
    provider
  )
  if (emitSynced && docGuid === provider.roomname && syncMessageType === syncProtocol.messageYjsSyncStep2 && !provider.synced) {
    provider.synced = true
  }

  // sub doc synced
  if (emitSynced && docGuid !== provider.roomname && syncMessageType === syncProtocol.messageYjsSyncStep2 && !provider._syncedStatus.get(docGuid)) {
    provider.updateSyncedStatus(docGuid, true)
  }
}

messageHandlers[messageQueryAwareness] = (
  encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  const docGuid = decoding.readVarString(decoder)
  log.debug("query awareness for: ", docGuid)
  const doc = provider.getDoc(docGuid)
  if (!doc) {
    console.error('query awareness:  doc not found with id: ', docGuid)
    return
  }
  let docAwareness = provider.getAwareness(docGuid)
  provider.encodeAwareness(encoder, docGuid, docAwareness, Array.from(docAwareness.getStates().keys()))
}

messageHandlers[messageAwareness] = (
  encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  const docGuid = decoding.readVarString(decoder)
  const doc = provider.getDoc(docGuid)
  if (!doc) {
    console.error('message awareness: doc not found with id: ', docGuid)
    return
  }
  alogger.debug("receiving awareness update for: ", docGuid)
  awarenessProtocol.applyAwarenessUpdate(
    provider.getAwareness(docGuid),
    decoding.readVarUint8Array(decoder),
    provider
  )
}

messageHandlers[messageAuth] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  authProtocol.readAuthMessage(
    decoder,
    provider.doc,
    (_ydoc, reason) => permissionDeniedHandler(provider, reason)
  )
}

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000

/**
 * @param {WebsocketProvider} provider
 * @param {string} reason
 */
const permissionDeniedHandler = (provider, reason) =>
  console.warn(`Permission denied to access ${provider.url}.\n${reason}`)

/**
 * @param {WebsocketProvider} provider
 * @param {Uint8Array} buf
 * @param {boolean} emitSynced
 * @return {encoding.Encoder}
 */
const readMessage = (provider, buf, emitSynced) => {
  const decoder = decoding.createDecoder(buf)
  const encoder = encoding.createEncoder()
  const messageType = decoding.readVarUint(decoder)
  const messageHandler = provider.messageHandlers[messageType]
  if (/** @type {any} */ (messageHandler)) {
    messageHandler(encoder, decoder, provider, emitSynced, messageType)
  } else {
    console.error('Unable to compute message')
  }
  return encoder
}

/**
 * checks if there is content in the decoder apart from [message type][docId] 
 * @param {encoding.Encoder} encoder
 */
const needSend = (encoder) => {
  const buf = encoding.toUint8Array(encoder)
  const decoder = decoding.createDecoder(buf)
  const messageType = decoding.readVarUint(decoder)
  const docId = decoding.readVarString(decoder)
  //checking remaining content
  return decoding.hasContent(decoder)
}

/**
 * @param {WebsocketProvider} provider
 */
const setupWS = (provider) => {
  if (provider.shouldConnect && provider.ws === null) {
    logger.debug("Setting up WS", provider.url)
    const websocket = new provider._WS(provider.url, provider.protocols)
    websocket.binaryType = 'arraybuffer'
    provider.ws = websocket
    provider.wsconnecting = true
    provider.wsconnected = false
    provider.synced = false

    websocket.onmessage = (event) => {
      provider.wsLastMessageReceived = time.getUnixTime()
      // @todo disable emitSync for now, should also notify sub docs
      const encoder = readMessage(provider, new Uint8Array(event.data), true)
      if (encoding.length(encoder) > 1 && needSend(encoder)) {
        if(websocket.readyState === websocket.OPEN) {
          websocket.send(encoding.toUint8Array(encoder))
        }
        else{
          logger.info("WebSocket send failed, trying to reconnect...")
        }
      }
    }
    websocket.onerror = (event) => {
      logger.error("WebSocket error:", event)
      provider.emit('connection-error', [event, provider])
    }
    websocket.onclose = (event) => {
      logger.error("WebSocket onClose:", event)
      provider.emit('connection-close', [event, provider])
      provider.ws = null
      provider.wsconnecting = false
      if (provider.wsconnected) {
        provider.wsconnected = false
        provider.synced = false

        for (const [docId, docAwareness] of provider.docsAwareness.entries()) {
          const doc = provider.getDoc(docId)
          // update awareness (all users except local left)
          awarenessProtocol.removeAwarenessStates(
            docAwareness,
            Array.from(docAwareness.getStates().keys()).filter((client) =>
              client !== doc.clientID
            ),
            provider
          )
        }
        provider.emit('status', [{
          status: 'disconnected'
        }])
      } else {
        provider.wsUnsuccessfulReconnects++
      }
      // Start with no reconnect timeout and increase timeout by
      // using exponential backoff starting with 100ms
      setTimeout(
        setupWS,
        math.min(
          math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
          provider.maxBackoffTime
        ),
        provider
      )
    }
    websocket.onopen = () => {
      provider.wsLastMessageReceived = time.getUnixTime()
      provider.wsconnecting = false
      provider.wsconnected = true
      provider.wsUnsuccessfulReconnects = 0

      // always send sync step 1 when connected (main doc & sub docs)
      for (const [k, doc] of provider.docs) {
        slogger.debug("sending sync step 1 for doc: ", k)
        const messageBytes= provider._encodeSyncStep1(k)
        websocket.send(messageBytes)
        slogger.debug("sent sync step 1 for doc: ", k)
      }

      for (const [docId, docAwareness] of provider.docsAwareness) {
        const doc = provider.getDoc(docId)
        // broadcast local awareness state
        if (docAwareness.getLocalState() !== null) {
          alogger.debug("sending awareness localState for doc: ", docId)

          const encoderAwarenessState = encoding.createEncoder()
          provider.encodeAwareness(encoderAwarenessState, docId, docAwareness, [doc.clientID])
          websocket.send(encoding.toUint8Array(encoderAwarenessState))
        }
      }

      provider.emit('status', [{
        status: 'connected'
      }])
    }
    provider.emit('status', [{
      status: 'connecting'
    }])
    logger.debug(`WebSocket setup to {} done`, provider.url)
  }
}

/**
 * @param {WebsocketProvider} provider
 * @param {ArrayBuffer} buf
 */
const broadcastMessage = (provider, buf) => {
  const ws = provider.ws
  if (provider.wsconnected && ws && ws.readyState === ws.OPEN) {
    ws.send(buf)
  }
  if (provider.bcconnected) {
    bc.publish(provider.bcChannel, buf, provider)
  }
}

/**
 * Websocket Provider for Yjs. Creates a websocket connection to sync the shared document.
 * The document name is attached to the provided url. I.e. the following example
 * creates a websocket connection to http://localhost:1234/my-document-name
 *
 * @example
 *   import * as Y from 'yjs'
 *   import { WebsocketProvider } from 'y-websocket'
 *   const doc = new Y.Doc()
 *   const provider = new WebsocketProvider('http://localhost:1234', 'my-document-name', doc)
 *
 * @extends {Observable<string>}
 */
export class WebsocketProvider extends Observable {
  /**
   * @param {string} serverUrl
   * @param {string} roomname
   * @param {Y.Doc} doc
   * @param {object} opts
   * @param {boolean} [opts.connect]
   * @param {awarenessProtocol.Awareness} [opts.awareness]
   * @param {Object<string,string>} [opts.params] specify url parameters
   * @param {Array<string>} [opts.protocols] specify websocket protocols
   * @param {typeof WebSocket} [opts.WebSocketPolyfill] Optionall provide a WebSocket polyfill
   * @param {number} [opts.resyncInterval] Request server state every `resyncInterval` milliseconds
   * @param {number} [opts.maxBackoffTime] Maximum amount of time to wait before trying to reconnect (we try to reconnect using exponential backoff)
   * @param {boolean} [opts.disableBc] Disable cross-tab BroadcastChannel communication
   */
  constructor (serverUrl, roomname, doc, {
    connect = true,
    awareness = new awarenessProtocol.Awareness(doc),
    params = {},
    protocols = [],
    WebSocketPolyfill = WebSocket,
    resyncInterval = -1,
    maxBackoffTime = 2500,
    disableBc = false
  } = {}) {
    super()
    // ensure that url is always ends with /
    while (serverUrl[serverUrl.length - 1] === '/') {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1)
    }
    this.serverUrl = serverUrl
    this.bcChannel = serverUrl + '/' + roomname
    this.maxBackoffTime = maxBackoffTime
    /**
     * The specified url parameters. This can be safely updated. The changed parameters will be used
     * when a new connection is established.
     * @type {Object<string,string>}
     */
    this.params = params
    this.protocols = protocols
    this.roomname = roomname
    this.doc = doc
    this._WS = WebSocketPolyfill
    this.awareness = awareness
    this.wsconnected = false
    this.wsconnecting = false
    this.bcconnected = false
    this.disableBc = disableBc
    this.wsUnsuccessfulReconnects = 0
    this.messageHandlers = messageHandlers.slice()
    /**
     * @type {boolean}
     */
    this._synced = false
    /**
     * @type {WebSocket?}
     */
    this.ws = null
    this.wsLastMessageReceived = 0
    /**
     * Whether to connect to other peers or not
     * @type {boolean}
     */
    this.shouldConnect = connect
    /**
     * manage all sub docs with main doc self
     * @type {Map}
     */
    this.docs = new Map()
    this.docs.set(this.roomname, doc)
    this.subdocUpdateHandlers = new Map()
    this.docsAwareness = new Map()
    this.docsAwareness.set(this.roomname, awareness)
    this.docsAwarenessUpdateHandlers = new Map()

    /**
     * store synced status for sub docs
     */
    this._syncedStatus = new Map()
    /**
     * @type {number}
     */
    this._resyncInterval = 0
    if (resyncInterval > 0) {
      this._resyncInterval = /** @type {any} */ (setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          // resend sync step 1 for all documents
          for (const [k, doc] of this.docs) {
            slogger.debug("resending sync step 1 for doc: ", k)
            const messageBytes = this._encodeSyncStep1(k)
            this.ws.send(messageBytes)
            slogger.debug("resent sync step 1 for doc: ", k)
          }
        }
      }, resyncInterval))
    }

    /**
     * @param {ArrayBuffer} data
     * @param {any} origin
     */
    this._bcSubscriber = (data, origin) => {
      if (origin !== this) {
        const encoder = readMessage(this, new Uint8Array(data), false)
        if (encoding.length(encoder) > 1 && needSend(encoder)) {
          bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this)
        }
      }
    }
    /**
     * Listens to Yjs updates and sends them to remote peers (ws and broadcastchannel)
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        const syncUpdateBytes = this._encodeSyncUpdate(this.roomname,update)
        this.logUpdate(this.roomname, origin, update);

        broadcastMessage(this, syncUpdateBytes)
      }
    }
    this.doc.on('update', this._updateHandler)
    /**
     * @param {any} changed
     * @param {any} _origin
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, _origin) => {
      const changedClients = added.concat(updated).concat(removed)
      const encoder = encoding.createEncoder()
      this.encodeAwareness(encoder, this.roomname, awareness, changedClients)
      broadcastMessage(this, encoding.toUint8Array(encoder))
    }

    /**
     * Listen to sub documents awareness updates
     * @param {String} docId identifier of sub documents
     * @returns update handler to push awareness to clients
     */
    this._getSubDocAwarenessHandler = (docId) =>
      ({ added, updated, removed }, _origin) => {
        const changedClients = added.concat(updated).concat(removed)
        const encoder = encoding.createEncoder()
        const subDocAwareness = this.docsAwareness.get(docId)

        this.encodeAwareness(encoder, docId, subDocAwareness, changedClients)

        broadcastMessage(this, encoding.toUint8Array(encoder))
      }

    this._exitHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        'app closed'
      )
      // we keep track of all awareness including the main doc in map
      // this.docsAwareness, the root doc will be removed twice and it is ok
      // as removal is idempotent
      for (const [docId, docAwareness] of this.docsAwareness.entries()) {
        const doc = this.getDoc(docId)
        awarenessProtocol.removeAwarenessStates(
          docAwareness,
          [doc.clientID],
          'app closed')
      }
    }

    if (env.isNode && typeof process !== 'undefined') {
      process.on('exit', this._exitHandler)
    }
    awareness.on('update', this._awarenessUpdateHandler)
    this._checkInterval = /** @type {any} */ (setInterval(() => {
      if (
        this.wsconnected &&
        messageReconnectTimeout <
          time.getUnixTime() - this.wsLastMessageReceived
      ) {
        // no message received in a long time - not even your own awareness
        // updates (which are updated every 15 seconds)
        /** @type {WebSocket} */ (this.ws).close()
      }
    }, messageReconnectTimeout / 10))
    if (connect) {
      this.connect()
    }
    /**
     * Listen to sub documents updates
     * @param {String} id identifier of sub documents
     * @returns
     */
    this._getSubDocUpdateHandler = (id) => {
      return (update, origin) => {
        if (origin === this) return
        this.logUpdate(id, origin, update);
        const syncUpdateBytes = this._encodeSyncUpdate(id,update);
        broadcastMessage(this, syncUpdateBytes)
      }
    }
  }

  logUpdate(docName, origin, update) {
    if (slogger.getLevel() <= log.levels.DEBUG) {
      slogger.debug(`Sending ydoc ${docName} update from ${origin}: `)
      Y.logUpdate(update)
    }
  }

  get url () {
    const encodedParams = url.encodeQueryParams(this.params)
    return this.serverUrl + '/' + this.roomname +
      (encodedParams.length === 0 ? '' : '?' + encodedParams)
  }

  encodeAwareness (encoder, docId, awareness, changedClients, states = awareness.states) {
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarString(encoder, docId)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients, states)
    )
  }

  _encodeSyncStep1 (docId) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    encoding.writeVarString(encoder, docId)
    syncProtocol.writeSyncStep1(encoder, this.docs.get(docId))
    return encoding.toUint8Array(encoder)
  }
  _encodeSyncStep2 (docId) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    encoding.writeVarString(encoder, docId)
    syncProtocol.writeSyncStep2(encoder, this.docs.get(docId))
    return encoding.toUint8Array(encoder)
  }

  _encodeSyncUpdate (docId, update) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    encoding.writeVarString(encoder, docId)
    syncProtocol.writeUpdate(encoder, update)
    return encoding.toUint8Array(encoder)
  }
  /**
   * @param {Y.Doc} subdoc
   */
  addSubdoc (subdoc) {
    let updateHandler = this._getSubDocUpdateHandler(subdoc.guid)
    this.docs.set(subdoc.guid, subdoc)
    subdoc.on('update', updateHandler)
    this.subdocUpdateHandlers.set(subdoc.guid, updateHandler)

    const subDocAwareness = new awarenessProtocol.Awareness(subdoc)
    const subDocAwarenessUpdateHandler = this._getSubDocAwarenessHandler(subdoc.guid)
    this.docsAwareness.set(subdoc.guid, subDocAwareness)
    subDocAwareness.on('update', subDocAwarenessUpdateHandler)
    this.docsAwarenessUpdateHandlers.set(subdoc.guid, subDocAwarenessUpdateHandler)

    // invoke sync step1
    const messageBytes = this._encodeSyncStep1(subdoc.guid)
    broadcastMessage(this, messageBytes)
  }

  /**
   * @param {Y.Doc} subdoc
   */
  removeSubdoc (subdoc) {
    subdoc.off('update', this.subdocUpdateHandlers.get(subdoc.guid))
    const awareness = this.docsAwareness.get(subdoc.guid)
    awareness.off('update', this.docsAwarenessUpdateHandlers.get(subdoc.guid))
  }

  /**
   * get doc by id (main doc or sub doc)
   * @param {String} id
   * @returns
   */
  getDoc (id) {
    return this.docs.get(id)
  }

  getAwareness (id) {
    return this.docsAwareness.get(id)
  }

  /**
   * @type {boolean}
   */
  get synced () {
    return this._synced
  }

  set synced (state) {
    if (this._synced !== state) {
      this._synced = state
      this.emit('synced', [state])
      this.emit('sync', [state])
    }
  }

  updateSyncedStatus (id, state) {
    const oldState = this._syncedStatus.get(id)
    if (oldState !== state) {
      this._syncedStatus.set(id, state)
      this.emit('subdoc_synced', [id, state])
      const doc = this.docs.get(id)
      if (doc) {
        doc.isSynced = state
        doc.emit('sync', [state, doc])
      }
    }
  }

  destroy () {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval)
    }
    clearInterval(this._checkInterval)
    this.disconnect()
    if (env.isNode && typeof process !== 'undefined') {
      process.off('exit', this._exitHandler)
    }
    this.awareness.off('update', this._awarenessUpdateHandler)
    this.doc.off('update', this._updateHandler)
    super.destroy()
  }

  connectBc () {
    if (this.disableBc) {
      return
    }
    if (!this.bcconnected) {
      bc.subscribe(this.bcChannel, this._bcSubscriber)
      this.bcconnected = true
    }
    // send sync step1 to bc
    // write sync step 1
    const sync1Bytes= this._encodeSyncStep1(this.roomname)
    bc.publish(this.bcChannel, sync1Bytes, this)
    // broadcast local state
    const sync2Bytes = this._encodeSyncStep2(this.roomname)
    bc.publish(this.bcChannel, sync2Bytes, this)
    logger.debug(`Connecting broadcast to ${this.url}, published sync step1`)

    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness)
    encoding.writeVarString(encoderAwarenessQuery, this.roomname)
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessQuery),
      this
    )
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder()

    this.encodeAwareness(encoderAwarenessState, this.roomname, this.awareness, [this.doc.clientID])

    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessState),
      this
    )
    logger.debug(`Connected broadcast to ${this.url}`)
  }

  disconnectBc () {
    // broadcast message with local awareness state set to null (indicating disconnect)
    const encoder = encoding.createEncoder()
    this.encodeAwareness(encoder, this.roomname, this.awareness, [this.doc.clientID], new Map())
    broadcastMessage(this, encoding.toUint8Array(encoder))
    if (this.bcconnected) {
      bc.unsubscribe(this.bcChannel, this._bcSubscriber)
      this.bcconnected = false
    }
  }

  
  disconnect () {
    this.shouldConnect = false
    this.disconnectBc()
    if (this.ws !== null) {
      this.ws.close()
    }
  }

  connect () {
    this.shouldConnect = true
    if (!this.wsconnected && this.ws === null) {
      setupWS(this)
      this.connectBc()
    }
  }
}
