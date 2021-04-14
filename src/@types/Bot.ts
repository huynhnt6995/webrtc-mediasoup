import { DataProducer, Router, Transport } from 'mediasoup/lib/types'
import { Peer } from 'protoo-server'


class Bot {
  static async create({ mediasoupRouter }: { mediasoupRouter: Router }) {
    const transport = await mediasoupRouter.createDirectTransport({
      maxMessageSize: 512,
    })
    const dataProducer = await transport.produceData({ label: 'bot' })
    const bot = new Bot({ transport, dataProducer })
    return bot
  }

  _transport: Transport
  _dataProducer: DataProducer

  constructor({
    transport,
    dataProducer,
  }: {
    transport: Transport
    dataProducer: DataProducer
  }) {
    this._transport = transport
    this._dataProducer = dataProducer
  }

  get dataProducer() {
    return this._dataProducer
  }
  close() {
    // No need to do anyting.
  }
  async handlePeerDataProducer({
    dataProducerId,
    peer,
  }: {
    dataProducerId: string
    peer: Peer
  }) {
    const dataConsumer = await this._transport.consumeData({
      dataProducerId,
    })
    dataConsumer.on('message', (message, ppid) => {
      if (ppid !== 51) {
        console.warn('ignoring non string messagee from a Peer')
        return
      }
      const text = message.toString('utf8')
      console.debug(
        'SCTP message received [peerId:%s, size:%d]',
        peer.id,
        message.byteLength,
      )
      const messageBack = `${peer.data.displayName} said me: "${text}"`
      this._dataProducer.send(messageBack)
    })
  }
}

export default Bot
