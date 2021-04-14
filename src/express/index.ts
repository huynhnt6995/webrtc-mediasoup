require('express-async-errors')

import * as fs from 'fs'
import * as https from 'https'
import * as url from 'url'

import * as express from "express";
import { WebSocketServer } from 'protoo-server'
import * as bodyParser from "body-parser";
import * as morgan from "morgan";
import * as cors from "cors";
import { AwaitQueue } from 'awaitqueue';

import { ResponseData } from "../@types/ResponseData";
import routers from './routers'
import config from "../mediasoup/config";
import Room from '../@types/Room';
import { getMediasoupWorker } from './../mediasoup'

const queue = new AwaitQueue()
const rooms = new Map<string, Room>()


export const start = async () => {

    // express

    const app = express();

    app.use(morgan('dev'))
    app.use(cors({ credentials: true, origin: (origin, cb) => cb(null, true) }))
    app.use(bodyParser.json())
    app.use(bodyParser.urlencoded({ extended: false }))

    app.use('/v1.0', routers)

    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
        console.error(err?.toString())
        const data = new ResponseData(undefined, { code: err.errorCode || 'UNKNOW_ERROR', message: err.message, stack: err.stack })
        res.json(data)
    })

    const tls = {
        cert: fs.readFileSync(config.https.tls.cert),
        key: fs.readFileSync(config.https.tls.key),
    }
    const httpsServer = https.createServer(tls, app)
    await new Promise(resolve => {
        httpsServer.listen(Number(config.https.listenPort), config.https.listenIp, undefined, () => resolve(undefined))
    })

    console.info('running an HTTPS server...', config.https.tls.cert, config.https.tls.key)


    // protoo web socket
    console.info('running protoo WebSocketServer...')
    const protooWebSocketServer = new WebSocketServer(httpsServer, {
        maxReceivedFrameSize: 960000,
        maxReceivedMessageSize: 960000,
        fragmentOutgoingMessages: true,
        fragmentationThreshold: 960000,
    })

    protooWebSocketServer.on('connectionrequest', (info, accept, reject) => {
        const u = url.parse(info.request.url || '', true)
        const roomId = u.query['roomId'] as string
        const peerId = u.query['peerId'] as string
        if (!roomId || !peerId) {
            reject(400, 'Connection request without roomId and/or peerId')
            return
        }
        console.info(
            'protoo connection request [roomId:%s, peerId:%s, address:%s, origin:%s]',
            roomId,
            peerId,
            info.socket.remoteAddress,
            info.origin,
        )
        // Serialize this code into the queue to avoid that two peers connecting at
        // the same time with the same roomId create two separate rooms with same
        // roomId.
        queue
            .push(async () => {
                const room = await getOrCreateRoom({ roomId })
                const protooWebSocketTransport = accept()
                room.handleProtooConnection({ peerId, protooWebSocketTransport })
            })
            .catch(error => {
                console.error('room creation or room joining failed:%o', error)
                reject(error)
            })
    })

    setInterval(() => {
        for (const room of rooms.values()) {
            room.logStatus()
        }
    }, 120000)
}

async function getOrCreateRoom({ roomId }: { roomId: string }) {
    let room = rooms.get(roomId)
    if (!room) {
        console.info('creating a new Room [roomId:%s]', roomId)
        const mediasoupWorker = getMediasoupWorker()
        room = await Room.create({ mediasoupWorker, roomId })
        rooms.set(roomId, room)
        room.on('close', () => rooms.delete(roomId))
    }
    return room
}