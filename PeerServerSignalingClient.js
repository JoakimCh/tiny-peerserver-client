
const HEARTBEAT_INTERVAL = 5000 // every 5 seconds

export class PeerServerSignalingClient extends EventTarget {
  #endpoint; #ws; #myId
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
    this.#newConnectionToken()
    this.#connect()
  }

  #newConnectionToken() {
    this.#connectionToken = Math.random().toString(36).slice(2)
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
      this.#newConnectionToken()
      if (isOpenOrOpening) {
        this.close() // (ID change require reconnection)
      }
    } else if (isOpenOrOpening) { // nothing to do then
      return
    }
    clearTimeout(this.#retryTimer) // abort any queued retry
    this.#connect()
  }

  close() {
    this.#connectionAttempt = this.#maxConnectionAttempts
    this.#ready = false
    this.#ws?.close()
  }

  sendSignal({receiver, description: sdp, candidate, metadata} = {}) {
    if (!receiver) throw Error('Signal must have a receiver.')
    const type = (candidate ? 'CANDIDATE' : sdp?.type.toUpperCase())
    if (!type) throw Error('Signal must contain a description or candidate.')
    if (!this.ready || this.#ws?.readyState != WebSocket.OPEN) {
      throw Error(`Can't send a signal when "ready" is false.`)
    }
    this.#ws.send(JSON.stringify({
      type, dst: receiver,
      payload: {sdp, candidate, metadata}
      // (JSON will NOT store undefined fields)
    }))
    if (globalThis['DEBUG_SIGNALING']) {
      const detail = {sender: this.myId}
      if (sdp) detail.description = sdp
      if (candidate) detail.candidate = candidate
      if (metadata) detail.metadata = metadata
      console.debug(type, detail)
    }
  }

  #queueRetry() {
    this.#retryTimer = setTimeout(this.#connect.bind(this), this.#retryDelay)
  }

  #connect() {
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
        detail: {message: ''+error, code: 'SIGNALING_SERVER_WS_CONNECTION_ERROR'}
      }))
      if (this.#connectionAttempt < this.#maxConnectionAttempts) {
        this.#queueRetry()
      }
      return // abort rest of code
    }
    const wsListenerAbortController = new AbortController()
    const signal = wsListenerAbortController.signal

    this.#ws.addEventListener('open', () => {
      this.#connectionAttempt = 0
      const heartbeatInterval = setInterval(() => {
        if (this.#ws.readyState != WebSocket.OPEN) return
        this.#ws.send('{"type":"HEARTBEAT"}')
        // if missing it will eventually just close the connection
      }, HEARTBEAT_INTERVAL)
      signal.onabort = () => clearInterval(heartbeatInterval)
    }, {signal})

    this.#ws.addEventListener('close', () => {
      wsListenerAbortController.abort()
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
        sdp: description, candidate, metadata} = {}} = msg
      const detail = {sender}
      if (description) detail.description = description
      if (candidate) detail.candidate = candidate
      if (metadata) detail.metadata = metadata
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
        this.dispatchEvent(new CustomEvent('ready', {detail: {myId: this.#myId}}))
      break
      case 'LEAVE':  // peerId has left
      case 'EXPIRE': // a signal to peerId could not be delivered
        this.dispatchEvent(new CustomEvent('expire', {detail: {peerId: msg.src}}))
        this.#channels.get(peerId)?.onExpire?.()
      break
      case 'OFFER': case 'ANSWER': case 'CANDIDATE': {
        const {type, src: sender, dst, payload: {
          sdp: description, candidate, metadata} = {}} = msg
        if (dst != this.#myId) throw Error('LOL, OMG!')
        const detail = {sender}
        if (metadata) detail.metadata = metadata
        if (candidate) detail.candidate = candidate
        if (description) detail.description = description
        this.dispatchEvent(new CustomEvent('signal', {detail}))
        this.#channels.get(sender)?.onSignal?.({description, candidate})
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
  #queue = new Set() // (a Set avoids duplicate signals)

  /** The onSignal({description, candidate}) callback */
  onSignal
  onExpire
  get myId() {return this.#signalingServerClient.myId}
  get peerId() {return this.#receiver}

  constructor(signalingServerClient, receiver) {
    this.#receiver = receiver
    this.#signalingServerClient = signalingServerClient
    signalingServerClient.addEventListener('ready', () => {
      for (const signal of this.#queue) {
        this.send(signal)
      }
      this.#queue.clear()
    })
  }

  send(signal) {
    if (!this.#signalingServerClient.ready) {
      this.#queue.add(signal)
      return
    }
    if (signal instanceof RTCSessionDescription) {
      this.#signalingServerClient.sendSignal({receiver: this.#receiver, description: signal})
    } else if (signal instanceof RTCIceCandidate) {
      this.#signalingServerClient.sendSignal({receiver: this.#receiver, candidate: signal})
    } else {
      throw Error(`Can't send signal without description or candidate.`)
    }
  }
}
