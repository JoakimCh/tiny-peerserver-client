
const HEARTBEAT_INTERVAL = 5000 // every 5 seconds

export class PeerServerSignalingClient extends EventTarget {
  #endpoint; #ws; #myId
  /** This token allows us to reconnect and keep our ID if the connection was non-gracefully closed (broken). */
  #connectionToken
  #connectionAttempt = 0; #maxConnectionAttempts; #retryDelay; #retryTimer
  #ready

  constructor({
    endpoint = 'wss://0.peerjs.com/peerjs', // https://status.peerjs.com/
    maxConnectionAttempts = 6,
    retryDelay = 1000,
    myId = crypto.randomUUID()
  }) {
    super()
    this.#endpoint = endpoint
    this.#maxConnectionAttempts = maxConnectionAttempts
    this.#retryDelay = retryDelay
    this.#myId = myId
    this.#getConnectionToken()
    setTimeout(this.#connect.bind(this), 0) // this allows events listeners to be setup before we dispatch the "connecting" event
    window.addEventListener('beforeunload', () => {
      // refreshing or closing a tab will gracefully close WebSocket connections
      if (this.#ws.readyState == WebSocket.OPEN) {
        sessionStorage.removeItem(this.#connectionToken) // signals a proper close
      }
    })
  }

  #getConnectionToken() {
    const storageKey = 'signalingToken-'+this.#myId
    this.#connectionToken = sessionStorage.getItem(storageKey)
    if (!this.#connectionToken) {
      this.#connectionToken = Math.random().toString(36).slice(2)
      sessionStorage.setItem(storageKey, this.#connectionToken)
    }
  }

  get myId() {return this.#myId}
  get ready() {return this.#ready}
  get maxConnectionAttempts() {return this.#maxConnectionAttempts}

  /** Returns a promise which resolves when ready or rejects at error or timeout. */
  createReadyPromise(timeout = this.#maxConnectionAttempts * this.#retryDelay) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onError({detail: {
          message: 'Signaling server connection timed out.',
          code: 'SIGNALING_SERVER_TIMEOUT'
        }})
      }, timeout)
      const onReady = () => {
        resolve()
        clearTimeout(timer)
        this.removeEventListener('error', onError)
      }
      const onError = ({detail: {message, code}}) => {
        const error = Error(message)
        error.code = code
        reject(error)
        clearTimeout(timer)
        this.removeEventListener('ready', onReady)
      }
      this.addEventListener('ready', onReady, {once: true})
      this.addEventListener('error', onError, {once: true})
    })
  }

  reconnect(newMyId = undefined) {
    const isOpenOrOpening = [WebSocket.CONNECTING, WebSocket.OPEN].includes(this.#ws?.readyState)
    this.#connectionAttempt = 0
    if (newMyId && newMyId != this.#myId) { // ID change
      this.#myId = newMyId
      this.#getConnectionToken()
      if (isOpenOrOpening) {
        this.close() // (ID change require reconnection)
      }
    } else if (isOpenOrOpening) { // nothing to do then
      return
    }
    if (this.#retryTimer) return // then it will run #connect()
    this.#connect()
  }

  close() {
    if (this.#connectWhenOnline) {
      window.removeEventListener('online', this.#connectWhenOnline)
      this.#connectWhenOnline = false
    }
    this.#connectionAttempt = this.#maxConnectionAttempts
    this.#ready = false
    this.#ws?.close()
  }

  sendSignal({receiver, description: sdp, candidate} = {}) {
    if (!receiver) throw Error('Signal must have a receiver.')
    const type = (candidate ? 'CANDIDATE' : sdp?.type.toUpperCase())
    if (!type) throw Error('Signal must contain a description or candidate.')
    if (!this.ready || this.#ws?.readyState != WebSocket.OPEN) {
      throw Error(`Can't send a signal when "ready" is false.`)
    }
    this.#ws.send(JSON.stringify({
      type, dst: receiver,
      payload: {sdp, candidate}
      // (JSON will NOT store undefined fields)
    }))
    if (globalThis['DEBUG_SIGNALING']) {
      const detail = {sender: this.myId}
      if (sdp) detail.description = sdp
      if (candidate) detail.candidate = candidate
      console.debug(type, detail)
    }
  }

  #queueRetry() {
    if (this.#retryTimer) return // already queued
    this.#retryTimer = setTimeout(this.#connect.bind(this), this.#retryDelay)
  }

  #connectWhenOnline

  #connect() {
    if (!navigator.onLine) {
      if (!this.#connectWhenOnline) {
        this.#connectWhenOnline = () => {
          this.#connectWhenOnline = false
          this.#connect()
        }
        window.addEventListener('online', this.#connectWhenOnline, {once: true})
      }
      return // no offline connection attempt
    }
    this.#retryTimer = false
    this.#ready = false
    const getParameters = new URLSearchParams({
      key: 'peerjs', // API key for the PeerServer
      id: this.#myId,
      token: this.#connectionToken
    })
    const endpointUrl = this.#endpoint+'?'+getParameters.toString()
    this.#connectionAttempt ++
    this.dispatchEvent(new CustomEvent('connecting', {detail: {
      connectionAttempt: this.#connectionAttempt, 
      lastAttempt: this.#connectionAttempt == this.#maxConnectionAttempts
    }}))
    try {
      this.#ws = new WebSocket(endpointUrl)
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', {
        detail: {message: ''+error, code: 'SIGNALING_SERVER_CONNECTION_ERROR'}
      }))
      if (this.#connectionAttempt < this.#maxConnectionAttempts) {
        this.#queueRetry()
      }
      return // abort rest of code
    }
    const wsListenerAbortController = new AbortController()
    const signal = wsListenerAbortController.signal // used to clear event listeners
    let didOpen

    this.#ws.addEventListener('open', () => {
      didOpen = true
      this.#connectionAttempt = 0
      const heartbeatInterval = setInterval(() => {
        if (this.#ws.readyState != WebSocket.OPEN) return
        this.#ws.send('{"type":"HEARTBEAT"}')
        // if missing it will eventually just close the connection
      }, HEARTBEAT_INTERVAL)
      signal.onabort = () => clearInterval(heartbeatInterval)
      // if we didn't have a clean close:
      if (sessionStorage.getItem(this.#connectionToken) == 'open') {
        // then we can continue the connection and it will not send us another "open" event
        this.#ready = true
        this.dispatchEvent(new CustomEvent('ready', {detail: {myId: this.#myId}}))
      }
    }, {signal})

    this.#ws.addEventListener('error', () => {
      this.#ready = false
      this.dispatchEvent(new CustomEvent('error', {
        detail: {message: 'WebSocket error.', code: 'SIGNALING_SERVER_CONNECTION_ERROR'}
      }))
      if (didOpen) return
      wsListenerAbortController.abort() // (no close event if it didn't open)
      if (this.#connectionAttempt < this.#maxConnectionAttempts) {
        this.#queueRetry()
      }
    }, {signal})

    this.#ws.addEventListener('close', ({code, reason, wasClean}) => {
      wsListenerAbortController.abort()
      if (wasClean) { // no longer bound to ID if gracefully closed
        sessionStorage.removeItem(this.#connectionToken)
      }
      const willRetry = this.#connectionAttempt < this.#maxConnectionAttempts
      if (this.#ready) { // only dispatch "closed" if it first had been "ready"
        this.#ready = false
        this.dispatchEvent(new CustomEvent('closed', {detail: {willRetry}}))
      }
      if (willRetry) this.#queueRetry()
    }, {signal})

    this.#ws.addEventListener('message', ({data}) => {
      let hadError
      try {
        data = JSON.parse(data)
      } catch (error) {
        this.#fatalError({
          message: 'Invalid signaling server protocol: '+data,
          code: 'SIGNALING_SERVER_INVALID_PROTOCOL'
        })
        hadError = true
      }
      if (hadError) return
      this.#messageHandler(data)
    }, {signal})
  }

  #fatalError({message, code}) {
    this.#ready = false
    this.close()
    this.dispatchEvent(new CustomEvent('error', {
      detail: {message, code}
    }))
  }

  #messageHandler(msg) {
    if (globalThis['DEBUG_SIGNALING']) {
      const {type, src: sender, payload: {
        sdp: description, candidate} = {}} = msg
      const detail = {sender}
      if (description) detail.description = description
      if (candidate) detail.candidate = candidate
      console.debug(type, detail)
    }
    switch (msg.type) {
      default:
        this.#fatalError({
          message: 'Unknown signaling server command.',
          code: 'SIGNALING_SERVER_UNKNOWN_CMD'
        })
      break
      case 'ERROR':
        this.#fatalError({
          message: 'Signaling server error: '+msg.payload?.msg,
          code: 'SIGNALING_SERVER_ERROR'
        })
      break
      case 'ID-TAKEN':
        this.#fatalError({
          message: 'Peer with this ID is already connected.', 
          code: 'SIGNALING_SERVER_PEERID_TAKEN'
        })
      break
      case 'OPEN':
        this.#ready = true
        sessionStorage.setItem(this.#connectionToken, 'open')
        this.dispatchEvent(new CustomEvent('ready', {detail: {myId: this.#myId}}))
      break
      case 'LEAVE':  // peerId has left
      case 'EXPIRE': // a signal to peerId could not be delivered
        this.dispatchEvent(new CustomEvent('expire', {detail: {peerId: msg.src}}))
        this.#channels.get(msg.src)?.onExpire?.()
      break
      case 'OFFER': case 'ANSWER': case 'CANDIDATE': {
        const {type, src: sender, dst, payload: {
          sdp: description, candidate} = {}} = msg
        if (dst != this.#myId) throw Error('LOL, OMG!')
        const detail = {sender, description, candidate}
        this.dispatchEvent(new CustomEvent('signal', {detail}))
        this.#channels.get(sender)?.onSignal?.(detail)
      } break
    }
  }

  #channels = new Map()
  getChannel(peerId) {
    let channel = this.#channels.get(peerId)
    if (!channel) {
      channel = new SignalingChannel(this, peerId)
      this.#channels.set(peerId, channel)
    }
    return channel
  }
  removeChannel(peerId) {
    this.#channels.delete(peerId)
  }
}

// for RTCPerfectNegotiator compatibility it needs the onSignal, onExpire, myId, peerId and send({description, candidate}) interface
class SignalingChannel {
  #receiver
  /** @type {PeerServerSignalingClient} */
  #signalingServerClient
  #queued = {description: false, candidates: new Set()}

  /** The onSignal({description, candidate}) callback */
  onSignal
  /** The onExpire(peerId) callback */
  onExpire
  get myId() {return this.#signalingServerClient.myId}
  get peerId() {return this.#receiver}

  constructor(signalingServerClient, receiver) {
    this.#receiver = receiver
    this.#signalingServerClient = signalingServerClient
    // whenever it is ready check the queue
    if (signalingServerClient.ready) {
      try {this.#handleQueue()} catch {}
    }
    signalingServerClient.addEventListener('ready', () => {
      this.#handleQueue()
    })
  }

  #handleQueue() {
    if (this.#queued.description) {
      this.send(this.#queued.description, true)
      this.#queued.description = false
    }
    for (const candidate of this.#queued.candidates) {
      this.#queued.candidates.delete(candidate)
      this.send(candidate, true)
    }
  }

  /** Send a signal, if offline it queues it and sends it when client is 'ready'. */
  send(signal, throwIfOffline = false) {
    let packet
    if (signal instanceof RTCSessionDescription || signal?.sdp) {
      packet = {receiver: this.#receiver, description: signal}
    } else if (signal instanceof RTCIceCandidate || signal?.candidate) {
      packet = {receiver: this.#receiver, candidate: signal}
    } else {
      throw Error(`Can't send signal without description or candidate.`)
    }
    try {
      this.#signalingServerClient.sendSignal(packet)
    } catch (error) {
      if (packet.description) {
        this.#queued.description = packet.description // keep the latest SDP
        this.#queued.candidates.clear() // (updated candidates always follow a SDP)
      } else {
        this.#queued.candidates.add(packet.candidate)
      }
      this.#signalingServerClient.reconnect()
      if (throwIfOffline) {
        throw error
      }
    }
  }
}

/** Given `myId` and a `signalingClient` it will ensure it is connected with the correct ID or throw an error while awaiting its promise. If no `signalingClient` given it will return a new one using the optional `config` given. 
@example
// first time it creates it, second time it ensures that it is ready with the current ID
try {
  signalingClient = ensureClientReady({myId, signalingClient})
} catch (error) {
  console.debug(error) // e.g. timeout
}
*/
export async function ensureClientReady({myId, signalingClient = undefined, config = {}}) {
  if (signalingClient) {
    if (!(signalingClient.ready && signalingClient.myId == myId)) {
      signalingClient.reconnect(myId)
    }
  } else {
    signalingClient = new PeerServerSignalingClient({...config, myId})
  }
  if (!signalingClient.ready) {
    await signalingClient.createReadyPromise()
  }
  return signalingClient
}
