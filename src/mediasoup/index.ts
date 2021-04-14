import config from './config'
import { createWorker, types } from 'mediasoup'


const mediasoupWorkers: types.Worker[] = []
let nextMediasoupWorkerIdx = 0

export async function createMediasoupWorkers() {
    const { numWorkers } = config.mediasoup
    console.info('running %d mediasoup workers...', numWorkers)

    for (let i = 0; i < numWorkers; ++i) {
        const worker = await createWorker({
            logLevel: config.mediasoup.workerSettings.logLevel,
            logTags: config.mediasoup.workerSettings.logTags,
            rtcMinPort: Number(config.mediasoup.workerSettings.rtcMinPort),
            rtcMaxPort: Number(config.mediasoup.workerSettings.rtcMaxPort),
        })
        worker.on('died', () => {
            console.error('mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid)
            setTimeout(() => process.exit(1), 2000)
        })
        mediasoupWorkers.push(worker)

        setInterval(async () => {
            const usage = await worker.getResourceUsage()
            console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage)
        }, 120 * 1000)
    }
}

export function getMediasoupWorker() {
    const worker = mediasoupWorkers[nextMediasoupWorkerIdx]
    if (++nextMediasoupWorkerIdx === mediasoupWorkers.length) {
        nextMediasoupWorkerIdx = 0
    }
    return worker
}