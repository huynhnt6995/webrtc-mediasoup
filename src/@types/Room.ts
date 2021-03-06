import throttle from '@sitespeed.io/throttle'
import { EventEmitter } from 'events'
import { AudioLevelObserver, Consumer, DataConsumer, DataProducer, DtlsParameters, Producer, Router, RtpCapabilities, RtpParameters, SctpCapabilities, SctpStreamParameters, Transport, Worker } from 'mediasoup/lib/types'
import { AcceptFn, Peer, ProtooRequest, RejectFn, Room as ProtooRoom, WebSocketTransport } from 'protoo-server'

import config from '../mediasoup/config'

import Bot from './Bot'

interface PeerInfo {
  id: string,
  displayName: string,
  device: any,
  producers: { id: string; kind: string } []
}

export interface Broadcaster {
  id: string
  data: {
    displayName: string
    device: {
      flag: string
      name: string
      version?: string
    }
    rtpCapabilities: RtpCapabilities
    transports: Map<string, Transport>
    producers: Map<string, Producer>
    consumers: Map<string, Consumer>
    dataProducers: Map<string, DataProducer>
    dataConsumers: Map<string, DataConsumer>
  }
}

/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter {
  static async create({
    mediasoupWorker,
    roomId,
  }: {
    mediasoupWorker: Worker
    roomId: string
  }) {
    console.info('create() [roomId:%s]', roomId)
    const protooRoom = new ProtooRoom()
    const { mediaCodecs } = config.mediasoup.routerOptions
    const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs })
    const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver({
      maxEntries: 1,
      threshold: -80,
      interval: 800,
    })
    const bot = await Bot.create({ mediasoupRouter })
    return new Room({
      roomId,
      protooRoom,
      mediasoupRouter,
      audioLevelObserver,
      bot,
    })
  }

  _roomId: string
  _closed: boolean
  _protooRoom: ProtooRoom
  _broadcasters: Map<string, Broadcaster>
  _mediasoupRouter: Router
  _audioLevelObserver: AudioLevelObserver
  _bot: Bot
  _networkThrottled: boolean

  constructor({
    roomId,
    protooRoom,
    mediasoupRouter,
    audioLevelObserver,
    bot,
  }: {
    roomId: string
    protooRoom: ProtooRoom
    mediasoupRouter: Router
    audioLevelObserver: AudioLevelObserver
    bot: Bot
  }) {
    super()
    this.setMaxListeners(Infinity)
    this._roomId = roomId
    this._closed = false
    this._protooRoom = protooRoom
    this._broadcasters = new Map()
    this._mediasoupRouter = mediasoupRouter
    this._audioLevelObserver = audioLevelObserver
    this._bot = bot
    this._networkThrottled = false
    this._handleAudioLevelObserver()
    Object.assign(global, {
      audioLevelObserver: this._audioLevelObserver,
      bot: this._bot,
    })
  }

  close() {
    console.debug('close()')
    this._closed = true
    this._protooRoom.close()
    this._mediasoupRouter.close()
    this._bot.close()
    this.emit('close')
    if (this._networkThrottled) {
      throttle.stop({}).catch(() => { })
    }
  }

  logStatus() {
    console.info(
      'logStatus() [roomId:%s, protoo Peers:%s, mediasoup Transports:%s]',
      this._roomId,
      this._protooRoom.peers.length,
      (this._mediasoupRouter as any)._transports?.size,
    )
  }

  async handleProtooConnection({
    peerId,
    consume,
    protooWebSocketTransport,
  }: {
    peerId: string
    consume?: boolean
    protooWebSocketTransport: WebSocketTransport
  }) {
    const existingPeer = this._protooRoom.getPeer(peerId)
    if (existingPeer) {
      console.warn(
        'handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]',
        peerId,
      )
      existingPeer.close()
    }

    let peer: Peer | null = null
    try {
      peer = await this._protooRoom.createPeer(peerId, protooWebSocketTransport)
    } catch (error) {
      console.error('protooRoom.createPeer() failed:%o', error)
    }
    if (!peer) {
      console.error('protooRoom.createPeer() failed:peer=null')
      return
    }
    const p = peer
    // Use the peer.data object to store mediasoup related objects.
    // Not joined after a custom protoo 'join' request is later received.
    p.data.consume = consume
    p.data.joined = false
    p.data.displayName = undefined
    p.data.device = undefined
    p.data.rtpCapabilities = undefined
    p.data.sctpCapabilities = undefined
    // Have mediasoup related maps ready even before the Peer joins since we
    // allow creating Transports before joining.
    p.data.transports = new Map()
    p.data.producers = new Map()
    p.data.consumers = new Map()
    p.data.dataProducers = new Map()
    p.data.dataConsumers = new Map()

    p.on('request', (request, accept, reject) => {
      console.debug(
        'protoo Peer "request" event [method:%s, peerId:%s]',
        request.method,
        p.id,
      )
      this._handleProtooRequest(p, request, accept, reject).catch(error => {
        console.error('request failed:%o', error)
        reject(error)
      })
    })

    p.on('close', () => {
      if (this._closed) {
        return
      }
      console.debug('protoo Peer "close" event [peerId:%s]', p.id)
      if (p.data.joined) {
        for (const otherPeer of this._getJoinedPeers({ excludePeer: p })) {
          otherPeer.notify('peerClosed', { peerId: p.id }).catch(() => { })
        }
      }
      for (const transport of p.data.transports.values()) {
        transport.close()
      }
      if (this._protooRoom.peers.length === 0) {
        console.info(
          'last Peer in the room left, closing the room [roomId:%s]',
          this._roomId,
        )
        this.close()
      }
    })
  }

  getRouterRtpCapabilities() {
    return this._mediasoupRouter.rtpCapabilities
  }

  async createBroadcaster({
    id,
    displayName,
    device = {},
    rtpCapabilities,
  }: {
    id: string
    displayName: string
    device?: {
      name?: string
      version?: string
    }
    rtpCapabilities: RtpCapabilities
  }) {
    if (typeof id !== 'string' || !id) {
      throw new TypeError('missing body.id')
    } else if (typeof displayName !== 'string' || !displayName) {
      throw new TypeError('missing body.displayName')
    } else if (typeof device.name !== 'string' || !device.name) {
      throw new TypeError('missing body.device.name')
    } else if (rtpCapabilities && typeof rtpCapabilities !== 'object') {
      throw new TypeError('wrong body.rtpCapabilities')
    }

    if (this._broadcasters.has(id)) {
      throw new Error(`broadcaster with id "${id}" already exists`)
    }

    const broadcaster = {
      id,
      data: {
        displayName,
        device: {
          flag: 'broadcaster',
          name: device.name || 'Unknown device',
          version: device.version,
        },
        rtpCapabilities,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        dataProducers: new Map(),
        dataConsumers: new Map(),
      },
    }

    // Store the Broadcaster into the map.
    this._broadcasters.set(broadcaster.id, broadcaster)

    // Notify the new Broadcaster to all Peers.
    for (const otherPeer of this._getJoinedPeers()) {
      otherPeer
        .notify('newPeer', {
          id: broadcaster.id,
          displayName: broadcaster.data.displayName,
          device: broadcaster.data.device,
        })
        .catch(() => { })
    }

    // Reply with the list of Peers and their Producers.
    const peerInfos: PeerInfo[] = []
    const joinedPeers = this._getJoinedPeers()

    // Just fill the list of Peers if the Broadcaster provided its rtpCapabilities.
    if (rtpCapabilities) {
      for (const joinedPeer of joinedPeers) {
        const peerInfo = {
          id: joinedPeer.id,
          displayName: joinedPeer.data.displayName,
          device: joinedPeer.data.device,
          producers: [] as { id: string; kind: string }[],
        }

        for (const producer of joinedPeer.data.producers.values()) {
          // Ignore Producers that the Broadcaster cannot consume.
          if (
            !this._mediasoupRouter.canConsume({
              producerId: producer.id,
              rtpCapabilities,
            })
          ) {
            continue
          }

          peerInfo.producers.push({
            id: producer.id,
            kind: producer.kind,
          })
        }

        peerInfos.push(peerInfo)
      }
    }

    return { peers: peerInfos }
  }

  deleteBroadcaster({ broadcasterId }: { broadcasterId: string }) {
    const broadcaster = this._broadcasters.get(broadcasterId)

    if (!broadcaster) {
      throw new Error(`broadcaster with id "${broadcasterId}" does not exist`)
    }

    for (const transport of broadcaster.data.transports.values()) {
      transport.close()
    }

    this._broadcasters.delete(broadcasterId)

    for (const peer of this._getJoinedPeers()) {
      peer.notify('peerClosed', { peerId: broadcasterId }).catch(() => { })
    }
  }

  async createBroadcasterTransport({
    broadcasterId,
    type,
    rtcpMux = false,
    comedia = true,
    sctpCapabilities,
  }: {
    broadcasterId: string
    type: 'plain' | 'webrtc'
    rtcpMux?: boolean
    comedia?: boolean
    sctpCapabilities?: SctpCapabilities
  }) {
    const broadcaster = this._broadcasters.get(broadcasterId)

    if (!broadcaster) {
      throw new Error(`broadcaster with id "${broadcasterId}" does not exist`)
    }

    switch (type) {
      case 'webrtc': {
        const webRtcTransportOptions = {
          ...config.mediasoup.webRtcTransportOptions,
          enableSctp: Boolean(sctpCapabilities),
          numSctpStreams: (sctpCapabilities || {}).numStreams,
        }

        const transport = await this._mediasoupRouter.createWebRtcTransport(
          webRtcTransportOptions,
        )

        // Store it.
        broadcaster.data.transports.set(transport.id, transport)

        return {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        }
      }

      case 'plain': {
        const plainTransportOptions = {
          ...config.mediasoup.plainTransportOptions,
          rtcpMux: rtcpMux,
          comedia: comedia,
        }

        const transport = await this._mediasoupRouter.createPlainTransport(
          plainTransportOptions,
        )

        // Store it.
        broadcaster.data.transports.set(transport.id, transport)

        return {
          id: transport.id,
          ip: transport.tuple.localIp,
          port: transport.tuple.localPort,
          rtcpPort: transport.rtcpTuple
            ? transport.rtcpTuple.localPort
            : undefined,
        }
      }

      default: {
        throw new TypeError('invalid type')
      }
    }
  }

  async connectBroadcasterTransport({
    broadcasterId,
    transportId,
    dtlsParameters,
  }: {
    broadcasterId: string
    transportId: string
    dtlsParameters: DtlsParameters
  }) {
    const broadcaster = this._broadcasters.get(broadcasterId)

    if (!broadcaster) {
      throw new Error(`broadcaster with id "${broadcasterId}" does not exist`)
    }

    const transport = broadcaster.data.transports.get(transportId)

    if (!transport) {
      throw new Error(`transport with id "${transportId}" does not exist`)
    }

    if (transport.constructor.name !== 'WebRtcTransport') {
      throw new Error(
        `transport with id "${transportId}" is not a WebRtcTransport`,
      )
    }

    await transport.connect({ dtlsParameters })
  }

  async createBroadcasterProducer({
    broadcasterId,
    transportId,
    kind,
    rtpParameters,
  }: {
    broadcasterId: string
    transportId: string
    kind: 'audio' | 'video'
    rtpParameters: RtpParameters
  }) {
    const broadcaster = this._broadcasters.get(broadcasterId)

    if (!broadcaster) {
      throw new Error(`broadcaster with id "${broadcasterId}" does not exist`)
    }

    const transport = broadcaster.data.transports.get(transportId)

    if (!transport) {
      throw new Error(`transport with id "${transportId}" does not exist`)
    }

    const producer = await transport.produce({ kind, rtpParameters })

    // Store it.
    broadcaster.data.producers.set(producer.id, producer)

    // Set Producer events.
    // producer.on('score', (score) =>
    // {
    // 	console.debug(
    // 		'broadcaster producer "score" event [producerId:%s, score:%o]',
    // 		producer.id, score);
    // });

    producer.on('videoorientationchange', videoOrientation => {
      console.debug(
        'broadcaster producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
        producer.id,
        videoOrientation,
      )
    })

    // Optimization: Create a server-side Consumer for each Peer.
    for (const peer of this._getJoinedPeers()) {
      this._createConsumer({
        consumerPeer: peer,
        producerPeer: broadcaster,
        producer,
      })
    }

    // Add into the audioLevelObserver.
    if (producer.kind === 'audio') {
      this._audioLevelObserver
        .addProducer({ producerId: producer.id })
        .catch(() => { })
    }

    return { id: producer.id }
  }

  async createBroadcasterConsumer({
    broadcasterId,
    transportId,
    producerId,
  }: {
    broadcasterId: string
    transportId: string
    producerId: string
  }) {
    const broadcaster = this._broadcasters.get(broadcasterId)

    if (!broadcaster) {
      throw new Error(`broadcaster with id "${broadcasterId}" does not exist`)
    }

    if (!broadcaster.data.rtpCapabilities) {
      throw new Error('broadcaster does not have rtpCapabilities')
    }

    const transport = broadcaster.data.transports.get(transportId)

    if (!transport) {
      throw new Error(`transport with id "${transportId}" does not exist`)
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: broadcaster.data.rtpCapabilities,
    })

    // Store it.
    broadcaster.data.consumers.set(consumer.id, consumer)

    // Set Consumer events.
    consumer.on('transportclose', () => {
      // Remove from its map.
      broadcaster.data.consumers.delete(consumer.id)
    })

    consumer.on('producerclose', () => {
      // Remove from its map.
      broadcaster.data.consumers.delete(consumer.id)
    })

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
    }
  }

  async createBroadcasterDataConsumer({
    broadcasterId,
    transportId,
    dataProducerId,
  }: {
    broadcasterId: string
    transportId: string
    dataProducerId: string
  }) {
    const broadcaster = this._broadcasters.get(broadcasterId)

    if (!broadcaster) {
      throw new Error(`broadcaster with id "${broadcasterId}" does not exist`)
    }

    if (!broadcaster.data.rtpCapabilities) {
      throw new Error('broadcaster does not have rtpCapabilities')
    }

    const transport = broadcaster.data.transports.get(transportId)

    if (!transport) {
      throw new Error(`transport with id "${transportId}" does not exist`)
    }

    const dataConsumer = await transport.consumeData({
      dataProducerId,
    })

    // Store it.
    broadcaster.data.dataConsumers.set(dataConsumer.id, dataConsumer)

    // Set Consumer events.
    dataConsumer.on('transportclose', () => {
      // Remove from its map.
      broadcaster.data.dataConsumers.delete(dataConsumer.id)
    })

    dataConsumer.on('dataproducerclose', () => {
      // Remove from its map.
      broadcaster.data.dataConsumers.delete(dataConsumer.id)
    })

    return {
      id: dataConsumer.id,
    }
  }

  async createBroadcasterDataProducer({
    broadcasterId,
    transportId,
    label,
    protocol,
    sctpStreamParameters,
    appData,
  }: {
    broadcasterId: string
    transportId: string
    label: string
    protocol: string
    sctpStreamParameters: SctpStreamParameters
    appData: any
  }) {
    const broadcaster = this._broadcasters.get(broadcasterId)

    if (!broadcaster) {
      throw new Error(`broadcaster with id "${broadcasterId}" does not exist`)
    }

    // if (!broadcaster.data.sctpCapabilities)
    // 	throw new Error('broadcaster does not have sctpCapabilities');

    const transport = broadcaster.data.transports.get(transportId)

    if (!transport) {
      throw new Error(`transport with id "${transportId}" does not exist`)
    }

    const dataProducer = await transport.produceData({
      sctpStreamParameters,
      label,
      protocol,
      appData,
    })

    // Store it.
    broadcaster.data.dataProducers.set(dataProducer.id, dataProducer)

    // Set Consumer events.
    dataProducer.on('transportclose', () => {
      // Remove from its map.
      broadcaster.data.dataProducers.delete(dataProducer.id)
    })

    // // Optimization: Create a server-side Consumer for each Peer.
    // for (const peer of this._getJoinedPeers())
    // {
    // 	this._createDataConsumer(
    // 		{
    // 			dataConsumerPeer : peer,
    // 			dataProducerPeer : broadcaster,
    // 			dataProducer: dataProducer
    // 		});
    // }

    return {
      id: dataProducer.id,
    }
  }

  _handleAudioLevelObserver() {
    this._audioLevelObserver.on('volumes', volumes => {
      const { producer, volume } = volumes[0]

      // console.debug(
      // 	'audioLevelObserver "volumes" event [producerId:%s, volume:%s]',
      // 	producer.id, volume);

      // Notify all Peers.
      for (const peer of this._getJoinedPeers()) {
        peer
          .notify('activeSpeaker', {
            peerId: producer.appData.peerId,
            volume: volume,
          })
          .catch(() => { })
      }
    })

    this._audioLevelObserver.on('silence', () => {
      // console.debug('audioLevelObserver "silence" event');

      // Notify all Peers.
      for (const peer of this._getJoinedPeers()) {
        peer.notify('activeSpeaker', { peerId: null }).catch(() => { })
      }
    })
  }

  /**
   * Handle protoo requests from browsers.
   *
   * @async
   */
  async _handleProtooRequest(
    peer: Peer,
    request: ProtooRequest,
    accept: AcceptFn,
    reject: RejectFn,
  ) {
    switch (request.method) {
      case 'getRouterRtpCapabilities': {
        accept(this._mediasoupRouter.rtpCapabilities)

        break
      }

      case 'join': {
        // Ensure the Peer is not already joined.
        if (peer.data.joined) {
          throw new Error('Peer already joined')
        }

        const {
          displayName,
          device,
          rtpCapabilities,
          sctpCapabilities,
        } = request.data

        // Store client data into the protoo Peer data object.
        peer.data.joined = true
        peer.data.displayName = displayName
        peer.data.device = device
        peer.data.rtpCapabilities = rtpCapabilities
        peer.data.sctpCapabilities = sctpCapabilities

        // Tell the new Peer about already joined Peers.
        // And also create Consumers for existing Producers.

        const joinedPeers = [
          ...this._getJoinedPeers(),
          ...this._broadcasters.values(),
        ]

        // Reply now the request with the list of joined peers (all but the new one).
        const peerInfos = joinedPeers
          .filter(joinedPeer => joinedPeer.id !== peer.id)
          .map(joinedPeer => ({
            id: joinedPeer.id,
            displayName: joinedPeer.data.displayName,
            device: joinedPeer.data.device,
          }))

        accept({ peers: peerInfos })

        // Mark the new Peer as joined.
        peer.data.joined = true

        for (const joinedPeer of joinedPeers) {
          // Create Consumers for existing Producers.
          for (const producer of joinedPeer.data.producers.values()) {
            this._createConsumer({
              consumerPeer: peer,
              producerPeer: joinedPeer,
              producer,
            })
          }

          // Create DataConsumers for existing DataProducers.
          for (const dataProducer of joinedPeer.data.dataProducers.values()) {
            if (dataProducer.label === 'bot') {
              continue
            }

            this._createDataConsumer({
              dataConsumerPeer: peer,
              dataProducerPeer: joinedPeer,
              dataProducer,
            })
          }
        }

        // Create DataConsumers for bot DataProducer.
        this._createDataConsumer({
          dataConsumerPeer: peer,
          dataProducerPeer: null,
          dataProducer: this._bot.dataProducer,
        })

        // Notify the new Peer to all other Peers.
        for (const otherPeer of this._getJoinedPeers({ excludePeer: peer })) {
          otherPeer
            .notify('newPeer', {
              id: peer.id,
              displayName: peer.data.displayName,
              device: peer.data.device,
            })
            .catch(() => { })
        }

        break
      }

      case 'createWebRtcTransport': {
        // NOTE: Don't require that the Peer is joined here, so the client can
        // initiate mediasoup Transports and be ready when he later joins.

        const {
          forceTcp,
          producing,
          consuming,
          sctpCapabilities,
        } = request.data

        const webRtcTransportOptions = {
          ...config.mediasoup.webRtcTransportOptions,
          enableSctp: Boolean(sctpCapabilities),
          numSctpStreams: (sctpCapabilities || {}).numStreams,
          appData: { producing, consuming },
        }

        if (forceTcp) {
          Object.assign(webRtcTransportOptions, {
            enableUdp: false,
            enableTcp: true,
          })
        }

        const transport = await this._mediasoupRouter.createWebRtcTransport(
          webRtcTransportOptions,
        )

        transport.on('sctpstatechange', sctpState => {
          console.debug(
            'WebRtcTransport "sctpstatechange" event [sctpState:%s]',
            sctpState,
          )
        })

        transport.on('dtlsstatechange', dtlsState => {
          if (dtlsState === 'failed' || dtlsState === 'closed') {
            console.warn(
              'WebRtcTransport "dtlsstatechange" event [dtlsState:%s]',
              dtlsState,
            )
          }
        })

        // NOTE: For testing.
        // await transport.enableTraceEvent([ 'probation', 'bwe' ]);
        await transport.enableTraceEvent(['bwe'])

        transport.on('trace', trace => {
          console.debug(
            'transport "trace" event [transportId:%s, trace.type:%s, trace:%o]',
            transport.id,
            trace.type,
            trace,
          )

          if (trace.type === 'bwe' && trace.direction === 'out') {
            peer
              .notify('downlinkBwe', {
                desiredBitrate: trace.info.desiredBitrate,
                effectiveDesiredBitrate: trace.info.effectiveDesiredBitrate,
                availableBitrate: trace.info.availableBitrate,
              })
              .catch(() => { })
          }
        })

        // Store the WebRtcTransport into the protoo Peer data Object.
        peer.data.transports.set(transport.id, transport)

        accept({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        })

        const { maxIncomingBitrate } = config.mediasoup.webRtcTransportOptions

        // If set, apply max incoming bitrate limit.
        if (maxIncomingBitrate) {
          try {
            await transport.setMaxIncomingBitrate(maxIncomingBitrate)
          } catch (error) { }
        }

        break
      }

      case 'connectWebRtcTransport': {
        const { transportId, dtlsParameters } = request.data
        const transport = peer.data.transports.get(transportId)

        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }

        await transport.connect({ dtlsParameters })

        accept(null)

        break
      }

      case 'restartIce': {
        const { transportId } = request.data
        const transport = peer.data.transports.get(transportId)

        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }

        const iceParameters = await transport.restartIce()

        accept(iceParameters)

        break
      }

      case 'produce': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { transportId, kind, rtpParameters } = request.data
        let { appData } = request.data
        const transport: Transport = peer.data.transports.get(transportId)

        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }

        // Add peerId into appData to later get the associated Peer during
        // the 'loudest' event of the audioLevelObserver.
        appData = { ...appData, peerId: peer.id }

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData,
          // keyFrameRequestDelay: 5000
        })

        // Store the Producer into the protoo Peer data Object.
        peer.data.producers.set(producer.id, producer)

        // Set Producer events.
        producer.on('score', score => {
          // console.debug(
          // 	'producer "score" event [producerId:%s, score:%o]',
          // 	producer.id, score);

          peer
            .notify('producerScore', { producerId: producer.id, score })
            .catch(() => { })
        })

        producer.on('videoorientationchange', videoOrientation => {
          console.debug(
            'producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
            producer.id,
            videoOrientation,
          )
        })

        // NOTE: For testing.
        // await producer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
        // await producer.enableTraceEvent([ 'pli', 'fir' ]);
        // await producer.enableTraceEvent([ 'keyframe' ]);

        producer.on('trace', trace => {
          console.debug(
            'producer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
            producer.id,
            trace.type,
            trace,
          )
        })

        accept({ id: producer.id })

        // Optimization: Create a server-side Consumer for each Peer.
        for (const otherPeer of this._getJoinedPeers({ excludePeer: peer })) {
          this._createConsumer({
            consumerPeer: otherPeer,
            producerPeer: peer,
            producer,
          })
        }

        // Add into the audioLevelObserver.
        if (producer.kind === 'audio') {
          this._audioLevelObserver
            .addProducer({ producerId: producer.id })
            .catch(() => { })
        }

        break
      }

      case 'closeProducer': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { producerId } = request.data
        const producer = peer.data.producers.get(producerId)

        if (!producer) {
          throw new Error(`producer with id "${producerId}" not found`)
        }

        producer.close()

        // Remove from its map.
        peer.data.producers.delete(producer.id)

        accept(null)

        break
      }

      case 'pauseProducer': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { producerId } = request.data
        const producer = peer.data.producers.get(producerId)

        if (!producer) {
          throw new Error(`producer with id "${producerId}" not found`)
        }

        await producer.pause()

        accept(null)

        break
      }

      case 'resumeProducer': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { producerId } = request.data
        const producer = peer.data.producers.get(producerId)

        if (!producer) {
          throw new Error(`producer with id "${producerId}" not found`)
        }

        await producer.resume()

        accept(null)

        break
      }

      case 'pauseConsumer': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { consumerId } = request.data
        const consumer = peer.data.consumers.get(consumerId)

        if (!consumer) {
          throw new Error(`consumer with id "${consumerId}" not found`)
        }

        await consumer.pause()

        accept(null)

        break
      }

      case 'resumeConsumer': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { consumerId } = request.data
        const consumer = peer.data.consumers.get(consumerId)

        if (!consumer) {
          throw new Error(`consumer with id "${consumerId}" not found`)
        }

        await consumer.resume()

        accept(null)

        break
      }

      case 'setConsumerPreferredLayers': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { consumerId, spatialLayer, temporalLayer } = request.data
        const consumer = peer.data.consumers.get(consumerId)

        if (!consumer) {
          throw new Error(`consumer with id "${consumerId}" not found`)
        }

        await consumer.setPreferredLayers({ spatialLayer, temporalLayer })

        accept(null)

        break
      }

      case 'setConsumerPriority': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { consumerId, priority } = request.data
        const consumer = peer.data.consumers.get(consumerId)

        if (!consumer) {
          throw new Error(`consumer with id "${consumerId}" not found`)
        }

        await consumer.setPriority(priority)

        accept(null)

        break
      }

      case 'requestConsumerKeyFrame': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { consumerId } = request.data
        const consumer = peer.data.consumers.get(consumerId)

        if (!consumer) {
          throw new Error(`consumer with id "${consumerId}" not found`)
        }

        await consumer.requestKeyFrame()

        accept(null)

        break
      }

      case 'produceData': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const {
          transportId,
          sctpStreamParameters,
          label,
          protocol,
          appData,
        } = request.data

        const transport = peer.data.transports.get(transportId)

        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }

        const dataProducer = await transport.produceData({
          sctpStreamParameters,
          label,
          protocol,
          appData,
        })

        // Store the Producer into the protoo Peer data Object.
        peer.data.dataProducers.set(dataProducer.id, dataProducer)

        accept({ id: dataProducer.id })

        switch (dataProducer.label) {
          case 'chat': {
            // Create a server-side DataConsumer for each Peer.
            for (const otherPeer of this._getJoinedPeers({
              excludePeer: peer,
            })) {
              this._createDataConsumer({
                dataConsumerPeer: otherPeer,
                dataProducerPeer: peer,
                dataProducer,
              })
            }

            break
          }

          case 'bot': {
            // Pass it to the bot.
            this._bot.handlePeerDataProducer({
              dataProducerId: dataProducer.id,
              peer,
            })

            break
          }
        }

        break
      }

      case 'changeDisplayName': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { displayName } = request.data
        const oldDisplayName = peer.data.displayName

        // Store the display name into the custom data Object of the protoo
        // Peer.
        peer.data.displayName = displayName

        // Notify other joined Peers.
        for (const otherPeer of this._getJoinedPeers({ excludePeer: peer })) {
          otherPeer
            .notify('peerDisplayNameChanged', {
              peerId: peer.id,
              displayName,
              oldDisplayName,
            })
            .catch(() => { })
        }

        accept(null)

        break
      }

      case 'mixerDataChanged': {
        // Ensure the Peer is joined.
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }
        // Notify other joined Peers.
        for (const otherPeer of this._getJoinedPeers({ excludePeer: peer })) {
          otherPeer.notify('mixerDataChanged', request.data).catch(() => { })
        }
        accept(null)
        break
      }

      case 'getTransportStats': {
        const { transportId } = request.data
        const transport = peer.data.transports.get(transportId)

        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }

        const stats = await transport.getStats()

        accept(stats)

        break
      }

      case 'getProducerStats': {
        const { producerId } = request.data
        const producer = peer.data.producers.get(producerId)

        if (!producer) {
          throw new Error(`producer with id "${producerId}" not found`)
        }

        const stats = await producer.getStats()

        accept(stats)

        break
      }

      case 'getConsumerStats': {
        const { consumerId } = request.data
        const consumer = peer.data.consumers.get(consumerId)

        if (!consumer) {
          throw new Error(`consumer with id "${consumerId}" not found`)
        }

        const stats = await consumer.getStats()

        accept(stats)

        break
      }

      case 'getDataProducerStats': {
        const { dataProducerId } = request.data
        const dataProducer = peer.data.dataProducers.get(dataProducerId)

        if (!dataProducer) {
          throw new Error(`dataProducer with id "${dataProducerId}" not found`)
        }

        const stats = await dataProducer.getStats()

        accept(stats)

        break
      }

      case 'getDataConsumerStats': {
        const { dataConsumerId } = request.data
        const dataConsumer = peer.data.dataConsumers.get(dataConsumerId)

        if (!dataConsumer) {
          throw new Error(`dataConsumer with id "${dataConsumerId}" not found`)
        }

        const stats = await dataConsumer.getStats()

        accept(stats)

        break
      }

      case 'applyNetworkThrottle': {
        const DefaultUplink = 1000000
        const DefaultDownlink = 1000000
        const DefaultRtt = 0

        const { uplink, downlink, rtt, secret } = request.data

        if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET) {
          reject(403, 'operation NOT allowed, modda fuckaa')

          return
        }

        try {
          await throttle.start({
            up: uplink || DefaultUplink,
            down: downlink || DefaultDownlink,
            rtt: rtt || DefaultRtt,
          })

          console.warn(
            'network throttle set [uplink:%s, downlink:%s, rtt:%s]',
            uplink || DefaultUplink,
            downlink || DefaultDownlink,
            rtt || DefaultRtt,
          )

          accept(null)
        } catch (error) {
          console.error('network throttle apply failed: %o', error)

          reject(500, error.toString())
        }

        break
      }

      case 'resetNetworkThrottle': {
        const { secret } = request.data

        if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET) {
          reject(403, 'operation NOT allowed, modda fuckaa')

          return
        }

        try {
          await throttle.stop({})

          console.warn('network throttle stopped')

          accept(null)
        } catch (error) {
          console.error('network throttle stop failed: %o', error)

          reject(500, error.toString())
        }

        break
      }

      default: {
        console.error('unknown request.method "%s"', request.method)

        reject(500, `unknown request.method "${request.method}"`)
      }
    }
  }

  /**
   * Helper to get the list of joined protoo peers.
   */
  _getJoinedPeers({
    excludePeer = undefined,
  }: {
    excludePeer?: Peer
  } = {}) {
    return this._protooRoom.peers.filter(
      peer => peer.data.joined && peer !== excludePeer,
    )
  }

  /**
   * Creates a mediasoup Consumer for the given mediasoup Producer.
   *
   * @async
   */
  async _createConsumer({
    consumerPeer,
    producerPeer,
    producer,
  }: {
    consumerPeer: Peer
    producerPeer: Broadcaster | Peer
    producer: Producer
  }) {
    // Optimization:
    // - Create the server-side Consumer in paused mode.
    // - Tell its Peer about it and wait for its response.
    // - Upon receipt of the response, resume the server-side Consumer.
    // - If video, this will mean a single key frame requested by the
    //   server-side Consumer (when resuming it).
    // - If audio (or video), it will avoid that RTP packets are received by the
    //   remote endpoint *before* the Consumer is locally created in the endpoint
    //   (and before the local SDP O/A procedure ends). If that happens (RTP
    //   packets are received before the SDP O/A is done) the PeerConnection may
    //   fail to associate the RTP stream.

    // NOTE: Don't create the Consumer if the remote Peer cannot consume it.
    if (
      !consumerPeer.data.rtpCapabilities ||
      !this._mediasoupRouter.canConsume({
        producerId: producer.id,
        rtpCapabilities: consumerPeer.data.rtpCapabilities,
      })
    ) {
      return
    }

    // Must take the Transport the remote Peer is using for consuming.
    const _transports = consumerPeer.data.transports.values() as Transport[]
    const transport = Array.from(_transports).find(t => t.appData.consuming)

    // This should not happen.
    if (!transport) {
      console.warn('_createConsumer() | Transport for consuming not found')

      return
    }

    // Create the Consumer in paused mode.
    let consumer: Consumer

    try {
      consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: consumerPeer.data.rtpCapabilities,
        paused: true,
      })
    } catch (error) {
      console.warn('_createConsumer() | transport.consume():%o', error)

      return
    }

    // Store the Consumer into the protoo consumerPeer data Object.
    consumerPeer.data.consumers.set(consumer.id, consumer)

    // Set Consumer events.
    consumer.on('transportclose', () => {
      // Remove from its map.
      consumerPeer.data.consumers.delete(consumer.id)
    })

    consumer.on('producerclose', () => {
      // Remove from its map.
      consumerPeer.data.consumers.delete(consumer.id)

      consumerPeer
        .notify('consumerClosed', { consumerId: consumer.id })
        .catch(() => { })
    })

    consumer.on('producerpause', () => {
      consumerPeer
        .notify('consumerPaused', { consumerId: consumer.id })
        .catch(() => { })
    })

    consumer.on('producerresume', () => {
      consumerPeer
        .notify('consumerResumed', { consumerId: consumer.id })
        .catch(() => { })
    })

    consumer.on('score', score => {
      // console.debug(
      // 	'consumer "score" event [consumerId:%s, score:%o]',
      // 	consumer.id, score);

      consumerPeer
        .notify('consumerScore', { consumerId: consumer.id, score })
        .catch(() => { })
    })

    consumer.on('layerschange', layers => {
      consumerPeer
        .notify('consumerLayersChanged', {
          consumerId: consumer.id,
          spatialLayer: layers ? layers.spatialLayer : null,
          temporalLayer: layers ? layers.temporalLayer : null,
        })
        .catch(() => { })
    })

    // NOTE: For testing.
    // await consumer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
    // await consumer.enableTraceEvent([ 'pli', 'fir' ]);
    // await consumer.enableTraceEvent([ 'keyframe' ]);

    consumer.on('trace', trace => {
      console.debug(
        'consumer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
        consumer.id,
        trace.type,
        trace,
      )
    })

    // Send a protoo request to the remote Peer with Consumer parameters.
    try {
      await consumerPeer.request('newConsumer', {
        peerId: producerPeer.id,
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        appData: producer.appData,
        producerPaused: consumer.producerPaused,
      })

      // Now that we got the positive response from the remote endpoint, resume
      // the Consumer so the remote endpoint will receive the a first RTP packet
      // of this new stream once its PeerConnection is already ready to process
      // and associate it.
      await consumer.resume()

      consumerPeer
        .notify('consumerScore', {
          consumerId: consumer.id,
          score: consumer.score,
        })
        .catch(() => { })
    } catch (error) {
      console.warn('_createConsumer() | failed:%o', error)
    }
  }

  /**
   * Creates a mediasoup DataConsumer for the given mediasoup DataProducer.
   *
   * @async
   */
  async _createDataConsumer({
    dataConsumerPeer,
    dataProducerPeer, // This is null for the bot DataProducer.
    dataProducer,
  }: {
    dataConsumerPeer: Peer
    dataProducerPeer?: Broadcaster | Peer | null
    dataProducer: DataProducer
  }) {
    // NOTE: Don't create the DataConsumer if the remote Peer cannot consume it.
    if (!dataConsumerPeer.data.sctpCapabilities) {
      return
    }

    // Must take the Transport the remote Peer is using for consuming.
    const _transports = dataConsumerPeer.data.transports.values() as Transport[]
    const transport = Array.from(_transports).find(t => t.appData.consuming)

    // This should not happen.
    if (!transport) {
      console.warn('_createDataConsumer() | Transport for consuming not found')
      return
    }

    let dataConsumer: DataConsumer

    try {
      dataConsumer = await transport.consumeData({
        dataProducerId: dataProducer.id,
      })
    } catch (error) {
      console.warn('_createDataConsumer() | transport.consumeData():%o', error)

      return
    }

    // Store the DataConsumer into the protoo dataConsumerPeer data Object.
    dataConsumerPeer.data.dataConsumers.set(dataConsumer.id, dataConsumer)

    // Set DataConsumer events.
    dataConsumer.on('transportclose', () => {
      // Remove from its map.
      dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id)
    })

    dataConsumer.on('dataproducerclose', () => {
      // Remove from its map.
      dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id)

      dataConsumerPeer
        .notify('dataConsumerClosed', { dataConsumerId: dataConsumer.id })
        .catch(() => { })
    })

    // Send a protoo request to the remote Peer with Consumer parameters.
    try {
      await dataConsumerPeer.request('newDataConsumer', {
        // This is null for bot DataProducer.
        peerId: dataProducerPeer ? dataProducerPeer.id : null,
        dataProducerId: dataProducer.id,
        id: dataConsumer.id,
        sctpStreamParameters: dataConsumer.sctpStreamParameters,
        label: dataConsumer.label,
        protocol: dataConsumer.protocol,
        appData: dataProducer.appData,
      })
    } catch (error) {
      console.warn('_createDataConsumer() | failed:%o', error)
    }
  }
}

export default Room
