require('dotenv').config()

import * as mediasoup from './mediasoup'
import * as express from './express'

async function run() {
    await mediasoup.createMediasoupWorkers()
    await express.start()
}

run()