import AMQPChannel from './amqp-channel.mjs'
import AMQPError from './amqp-error.mjs'
import AMQPMessage from './amqp-message.mjs'
import AMQPView from './amqp-view.mjs'

const CLIENT_VERSION = '1.0.1'

export default class AMQPBaseClient {
  constructor(vhost, username, password, name, platform) {
    this.vhost = vhost
    this.username = username
    Object.defineProperty(this, 'password', {
      value: password,
      enumerable: false // hide it from console.log etc.
    })
    this.name = name // connection name
    this.platform = platform
    this.channels = [0]
  }

  connect() {
    throw "Abstract method not implemented"
  }

  send() {
    throw "Abstract method not implemented"
  }

  closeSocket() {
    throw "Abstract method not implemented"
  }

  close({ code = 200, reason = "" } = {}) {
    let j = 0
    const frame = new AMQPView(new ArrayBuffer(512))
    frame.setUint8(j, 1); j += 1 // type: method
    frame.setUint16(j, 0); j += 2 // channel: 0
    frame.setUint32(j, 0); j += 4 // frameSize
    frame.setUint16(j, 10); j += 2 // class: connection
    frame.setUint16(j, 50); j += 2 // method: close
    frame.setUint16(j, code); j += 2 // reply code
    j += frame.setShortString(j, reason) // reply reason
    frame.setUint16(j, 0); j += 2 // failing-class-id
    frame.setUint16(j, 0); j += 2 // failing-method-id
    frame.setUint8(j, 206); j += 1 // frame end byte
    frame.setUint32(3, j - 8) // update frameSize
    this.send(new Uint8Array(frame.buffer, 0, j))
  }

  channel(id) {
    return new Promise((resolve, reject) => {
      // Store channels in an array, set position to null when channel is closed
      // Look for first null value or add one the end
      if (!id)
        id = this.channels.findIndex((ch) => ch === undefined)
      if (id === -1) id = this.channels.length
      const channel = new AMQPChannel(this, id)
      this.channels[id] = channel
      channel.resolvePromise = resolve
      channel.rejectPromise = reject

      let j = 0
      const channelOpen = new AMQPView(new ArrayBuffer(13))
      channelOpen.setUint8(j, 1); j += 1 // type: method
      channelOpen.setUint16(j, id); j += 2 // channel id
      channelOpen.setUint32(j, 5); j += 4 // frameSize
      channelOpen.setUint16(j, 20); j += 2 // class: channel
      channelOpen.setUint16(j, 10); j += 2 // method: open
      channelOpen.setUint8(j, 0); j += 1 // reserved1
      channelOpen.setUint8(j, 206); j += 1 // frame end byte
      this.send(channelOpen.buffer)
    })
  }

  parseFrames(view) {
    // Can possibly be multiple AMQP frames in a single WS frame
    for (let i = 0; i < view.byteLength;) {
      let j = 0 // position in outgoing frame
      const type = view.getUint8(i); i += 1
      const channelId = view.getUint16(i); i += 2
      const frameSize = view.getUint32(i); i += 4
      switch (type) {
        case 1: { // method
          const classId = view.getUint16(i); i += 2
          const methodId = view.getUint16(i); i += 2
          switch (classId) {
            case 10: { // connection
              switch (methodId) {
                case 10: { // start
                  // ignore start frame, just reply startok
                  i += frameSize - 4

                  const startOk = new AMQPView(new ArrayBuffer(4096))
                  startOk.setUint8(j, 1); j += 1 // type: method
                  startOk.setUint16(j, 0); j += 2 // channel: 0
                  startOk.setUint32(j, 0); j += 4 // frameSize: to be updated
                  startOk.setUint16(j, 10); j += 2 // class: connection
                  startOk.setUint16(j, 11); j += 2 // method: startok
                  const clientProps = {
                    connection_name: this.name || '',
                    product: "amqp-client.js",
                    information: "https://github.com/cloudamqp/amqp-client.js",
                    version: CLIENT_VERSION,
                    platform: this.platform,
                    capabilities: {
                      "authentication_failure_close": true,
                      "basic.nack": true,
                      "connection.blocked": false,
                      "consumer_cancel_notify": true,
                      "exchange_exchange_bindings": true,
                      "per_consumer_qos": true,
                      "publisher_confirms": true,
                    }
                  }
                  j += startOk.setTable(j, clientProps) // client properties
                  j += startOk.setShortString(j, "PLAIN") // mechanism
                  const response = `\u0000${this.username}\u0000${this.password}`
                  j += startOk.setLongString(j, response) // response
                  j += startOk.setShortString(j, "") // locale
                  startOk.setUint8(j, 206); j += 1 // frame end byte
                  startOk.setUint32(3, j - 8) // update frameSize
                  this.send(new Uint8Array(startOk.buffer, 0, j))
                  break
                }
                case 30: { // tune
                  const channelMax = view.getUint16(i); i += 2
                  const frameMax = view.getUint32(i); i += 4
                  const heartbeat = view.getUint16(i); i += 2
                  this.channelMax = channelMax
                  this.frameMax = Math.min(4096, frameMax)
                  this.heartbeat = Math.min(0, heartbeat)

                  const tuneOk = new AMQPView(new ArrayBuffer(20))
                  tuneOk.setUint8(j, 1); j += 1 // type: method
                  tuneOk.setUint16(j, 0); j += 2 // channel: 0
                  tuneOk.setUint32(j, 12); j += 4 // frameSize: 12
                  tuneOk.setUint16(j, 10); j += 2 // class: connection
                  tuneOk.setUint16(j, 31); j += 2 // method: tuneok
                  tuneOk.setUint16(j, this.channelMax); j += 2 // channel max
                  tuneOk.setUint32(j, this.frameMax); j += 4 // frame max
                  tuneOk.setUint16(j, this.heartbeat); j += 2 // heartbeat
                  tuneOk.setUint8(j, 206); j += 1 // frame end byte
                  this.send(new Uint8Array(tuneOk.buffer, 0, j))

                  j = 0
                  const open = new AMQPView(new ArrayBuffer(512))
                  open.setUint8(j, 1); j += 1 // type: method
                  open.setUint16(j, 0); j += 2 // channel: 0
                  open.setUint32(j, 0); j += 4 // frameSize: to be updated
                  open.setUint16(j, 10); j += 2 // class: connection
                  open.setUint16(j, 40); j += 2 // method: open
                  j += open.setShortString(j, this.vhost) // vhost
                  open.setUint8(j, 0); j += 1 // reserved1
                  open.setUint8(j, 0); j += 1 // reserved2
                  open.setUint8(j, 206); j += 1 // frame end byte
                  open.setUint32(3, j - 8) // update frameSize
                  this.send(new Uint8Array(open.buffer, 0, j))

                  break
                }
                case 41: { // openok
                  i += 1 // reserved1
                  this.resolvePromise(this)
                  break
                }
                case 50: { // close
                  const code = view.getUint16(i); i += 2
                  const [text, strLen] = view.getShortString(i); i += strLen
                  const classId = view.getUint16(i); i += 2
                  const methodId = view.getUint16(i); i += 2
                  console.debug("connection closed by server", code, text, classId, methodId)

                  const closeOk = new AMQPView(new ArrayBuffer(12))
                  closeOk.setUint8(j, 1); j += 1 // type: method
                  closeOk.setUint16(j, 0); j += 2 // channel: 0
                  closeOk.setUint32(j, 4); j += 4 // frameSize
                  closeOk.setUint16(j, 10); j += 2 // class: connection
                  closeOk.setUint16(j, 51); j += 2 // method: closeok
                  closeOk.setUint8(j, 206); j += 1 // frame end byte
                  this.send(new Uint8Array(closeOk.buffer, 0, j))
                  const msg = `connection closed: ${text} (${code})`
                  this.rejectPromise(new AMQPError(msg, this))

                  this.closeSocket()
                  break
                }
                case 51: { // closeOk
                  this.closeSocket()
                  break
                }
                default:
                  i += frameSize - 4
                  console.error("unsupported class/method id", classId, methodId)
              }
              break
            }
            case 20: { // channel
              switch (methodId) {
                case 11: { // openok
                  i += 4 // reserved1 (long string)
                  const channel = this.channels[channelId]
                  channel.resolvePromise(channel)
                  break
                }
                case 40: { // close
                  const code = view.getUint16(i); i += 2
                  const [text, strLen] = view.getShortString(i); i += strLen
                  const classId = view.getUint16(i); i += 2
                  const methodId = view.getUint16(i); i += 2

                  console.debug("channel", channelId, "closed", code, text, classId, methodId)
                  const closeOk = new AMQPView(new ArrayBuffer(12))
                  closeOk.setUint8(j, 1); j += 1 // type: method
                  closeOk.setUint16(j, channelId); j += 2 // channel
                  closeOk.setUint32(j, 4); j += 4 // frameSize
                  closeOk.setUint16(j, 20); j += 2 // class: channel
                  closeOk.setUint16(j, 41); j += 2 // method: closeok
                  closeOk.setUint8(j, 206); j += 1 // frame end byte
                  this.send(new Uint8Array(closeOk.buffer, 0, j))

                  const channel = this.channels[channelId]
                  if (channel) {
                    const msg = `channel ${channelId} closed: ${text} (${code})`
                    channel.rejectPromise(new AMQPError(msg, this))
                    delete this.channels[channelId]
                  } else {
                    console.warn("channel", channelId, "already closed")
                  }

                  break
                }
                default:
                  i += frameSize - 4 // skip rest of frame
                  console.error("unsupported class/method id", classId, methodId)
              }
              break
            }
            case 50: { // queue
              switch (methodId) {
                case 11: { // declareOk
                  const [name, strLen] = view.getShortString(i); i += strLen
                  const messageCount = view.getUint32(i); i += 4
                  const consumerCount = view.getUint32(i); i += 4
                  const channel = this.channels[channelId]
                  channel.resolvePromise({ name, messageCount, consumerCount })
                  break
                }
                case 21: { // bindOk
                  const channel = this.channels[channelId]
                  channel.resolvePromise()
                  break
                }
                case 31: { // purgeOk
                  const messageCount = view.getUint32(i); i += 4
                  const channel = this.channels[channelId]
                  channel.resolvePromise({ messageCount })
                  break
                }
                case 41: { // deleteOk
                  const messageCount = view.getUint32(i); i += 4
                  const channel = this.channels[channelId]
                  channel.resolvePromise({ messageCount })
                  break
                }
                case 51: { // unbindOk
                  const channel = this.channels[channelId]
                  channel.resolvePromise()
                  break
                }
                default:
                  i += frameSize - 4
                  console.error("unsupported class/method id", classId, methodId)
              }
              break
            }
            case 60: { // basic
              switch (methodId) {
                case 11: { // qosOk
                  const channel = this.channels[channelId]
                  channel.resolvePromise()
                  break
                }
                case 21: { // consumeOk
                  const [ consumerTag, len ] = view.getShortString(i); i += len
                  const channel = this.channels[channelId]
                  channel.resolvePromise(consumerTag)
                  break
                }
                case 31: { // cancelOk
                  const [consumerTag, len] = view.getShortString(i); i += len
                  const channel = this.channels[channelId]
                  channel.resolvePromise(consumerTag)
                  break
                }
                case 60: { // deliver
                  const [ consumerTag, consumerTagLen ] = view.getShortString(i); i += consumerTagLen
                  const deliveryTag = view.getUint64(i); i += 8
                  const redeliviered = view.getUint8(i) === 1; i += 1
                  const [ exchange, exchangeLen ]= view.getShortString(i); i += exchangeLen
                  const [ routingKey, routingKeyLen ]= view.getShortString(i); i += routingKeyLen
                  const channel = this.channels[channelId]
                  if (!channel) {
                    console.warn("Cannot deliver to closed channel", channelId)
                    return
                  }
                  const message = new AMQPMessage(channel)
                  message.consumerTag = consumerTag
                  message.deliveryTag = deliveryTag
                  message.exchange = exchange
                  message.routingKey = routingKey
                  message.redeliviered = redeliviered
                  channel.delivery = message
                  break
                }
                default:
                  i += frameSize - 4
                  console.error("unsupported class/method id", classId, methodId)
              }
              break
            }
            case 85: { // confirm
              switch (methodId) {
                case 11: { // selectOk
                  const channel = this.channels[channelId]
                  channel.resolvePromise()
                  break
                }
              }
              break
            }
            default:
              i += frameSize - 2
              console.error("unsupported class id", classId)
          }
          break
        }
        case 2: { // header
          i += 2 // ignoring class id
          i += 2 // ignoring weight
          const bodySize = view.getUint64(i); i += 8
          const [properties, propLen] = view.getProperties(i); i += propLen

          const channel = this.channels[channelId]
          if (!channel) {
            console.warn("Cannot deliver to closed channel", channelId)
            break
          }
          const delivery = channel.delivery
          delivery.bodySize = bodySize
          delivery.properties = properties
          delivery.body = new Uint8Array(bodySize)
          delivery.bodyPos = 0 // if body is split over multiple frames
          if (bodySize === 0)
            channel.deliver()
          break
        }
        case 3: { // body
          const channel = this.channels[channelId]
          if (!channel) {
            console.warn("Cannot deliver to closed channel", channelId)
            break
          }
          const delivery = channel.delivery
          const bodyPart = new Uint8Array(view.buffer, i, frameSize)
          delivery.body.set(bodyPart, delivery.bodyPos)
          delivery.bodyPos += frameSize
          i += frameSize
          if (delivery.bodyPos === delivery.bodySize)
            channel.deliver()
          break
        }
        case 8: { // heartbeat
          const heartbeat = new AMQPView(new ArrayBuffer(8))
          heartbeat.setUint8(j, 1); j += 1 // type: method
          heartbeat.setUint16(j, 0); j += 2 // channel: 0
          heartbeat.setUint32(j, 0); j += 4 // frameSize
          heartbeat.setUint8(j, 206); j += 1 // frame end byte
          this.send(new Uint8Array(heartbeat.buffer, 0, j))
          break
        }
        default:
          console.error("invalid frame type:", type)
          i += frameSize
      }
      const frameEnd = view.getUint8(i); i += 1
      if (frameEnd != 206)
        console.error("Invalid frame end", frameEnd)
    }
  }
}
