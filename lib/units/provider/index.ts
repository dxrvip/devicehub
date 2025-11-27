import logger from '../../util/logger.js'
import wire from '../../wire/index.js'
import wireutil from '../../wire/util.js'
import {WireRouter} from '../../wire/router.js'
import * as procutil from '../../util/procutil.js'
import lifecycle from '../../util/lifecycle.js'
import srv from '../../util/srv.js'
import * as zmqutil from '../../util/zmqutil.js'
import {ChildProcess} from 'node:child_process'
import ADBObserver, {ADBDevice} from './ADBObserver.js'
import { DeviceRegisteredMessage } from '../../wire/wire.js'

interface DeviceWorker {
    state: 'waiting' | 'starting' | 'running'
    time: number
    terminate: () => Promise<void> | void
    resolveRegister?: () => void
    register: Promise<void>
    waitingTimeoutTimer?: NodeJS.Timeout
    ports: number[]
    delete: () => void
}

export interface Options {
    name: string
    adbHost: string
    adbPort: number
    ports: number[]
    allowRemote: boolean
    killTimeout: number
    deviceType: string
    endpoints: {
        push: string[]
        sub: string[]
    }
    filter: (device: ADBDevice) => boolean
    fork: (device: ADBDevice, ports: number[]) => ChildProcess
}

export default (async function(options: Options) {
    const log = logger.createLogger('provider')

    // Startup timeout for device workers
    const STARTUP_TIMEOUT_MS = 10 * 60 * 1000

    // Check whether the ipv4 address contains a port indication
    if (options.adbHost.includes(':')) {
        log.error('Please specify adbHost without port')
        lifecycle.fatal()
    }

    const workers: Record<string, DeviceWorker> = {}

    const solo = wireutil.makePrivateChannel()

    // To make sure that we always bind the same type of service to the same
    // port, we must ensure that we allocate ports in fixed groups.
    let ports = options.ports.slice(0, options.ports.length - options.ports.length % 4)

    // Output
    const push = zmqutil.socket('push')
    try {
        await Promise.all(options.endpoints.push.map(async(endpoint) => {
            const records = await srv.resolve(endpoint)
            return srv.attempt(records, (record) => {
                log.info('Sending output to "%s"', record.url)
                push.connect(record.url)
            })
        }))
    }
    catch (err) {
        log.fatal('Unable to connect to push endpoint: %s', err)
        lifecycle.fatal()
    }

    // Input
    const sub = zmqutil.socket('sub')
    try {
        await Promise.all(options.endpoints.sub.map(async(endpoint) => {
            const records = await srv.resolve(endpoint)
            return srv.attempt(records, (record) => {
                log.info('Receiving input to "%s"', record.url)
                sub.connect(record.url)
            })
        }))

        ;[solo].forEach(function(channel) {
            log.info('Subscribing to permanent channel "%s"', channel)
            sub.subscribe(channel)
        })

        sub.on('message', new WireRouter()
            .on(DeviceRegisteredMessage, (channel, message: {serial: string}) => {
                if (workers[message.serial]?.resolveRegister) {
                    workers[message.serial].resolveRegister!()
                    delete workers[message.serial].resolveRegister
                }
            })
            .handler()
        )
    }
    catch (err) {
        log.fatal('Unable to connect to sub endpoint: %s', err)
        lifecycle.fatal()
    }

    // Helper for ignoring unwanted devices
    const filterDevice = (listener: (device: ADBDevice, oldType?: ADBDevice['type']) => any | Promise<any>) =>
        ((device: ADBDevice, oldType?: ADBDevice['type']) => {
            if (device.serial === '????????????') {
                log.warn('ADB lists a weird device: "%s"', device.serial)
                return false
            }
            if (!options.allowRemote && device.serial.includes(':')) {
                log.info('Filtered out remote device "%s", use --allow-remote to override', device.serial)
                return false
            }
            if (options.filter && !options.filter(device)) {
                log.info('Filtered out device "%s"', device.serial)
                return false
            }
            return listener(device, oldType)
        }) as (device: ADBDevice, oldType?: ADBDevice['type']) => any | Promise<any>

    const stop = async(device: ADBDevice) => {
        if (workers[device.serial]) {
            log.info('Shutting down device worker "%s" [%s]', device.serial, device.type)
            return workers[device.serial]?.terminate()
        }
    }

    const removeDevice = async(device: ADBDevice) => {
        try {
            log.info('Removing device %s', device.serial)
            await stop(device)
        }
        catch (err) {
            log.error('Error stopping device worker "%s": %s', device.serial, err)
        }
        finally {
            // Always clean up and return ports, even if stop() fails
            if (workers[device.serial]) {
                workers[device.serial].delete()
            }
        }
    }

    const register = (device: ADBDevice) => new Promise<void>(async(resolve) =>{
        log.info('Registering device')

        // Tell others we found a device
        push.send([
            wireutil.global,
            wireutil.envelope(new wire.DeviceIntroductionMessage(device.serial, wireutil.toDeviceStatus(device.type) || 1, new wire.ProviderMessage(solo, options.name), options.deviceType))
        ])

        process.nextTick(() => { // after creating workers[device.serial] obj
            if (workers[device.serial]) {
                workers[device.serial].resolveRegister = () => resolve()
            }
        })
    })

    const spawn = (device: ADBDevice, onReady: () => Promise<any> | any, onError: (error: any) => Promise<any> | any) => {
        if (!workers[device.serial]) { // when device disconnected - stop restart loop
            return
        }

        const proc = options.fork(device, [...workers[device.serial].ports])
        log.info('Spawned a device worker with ports [ %s ]', workers[device.serial].ports.join(', '))

        const cleanup = () => {
            proc.removeAllListeners('exit')
            proc.removeAllListeners('error')
            proc.removeAllListeners('message')
        }

        const exitListener = (code?: number, signal?: string) => {
            cleanup()

            if (signal) {
                log.warn('Device worker "%s" was killed with signal %s, assuming deliberate action and not restarting', device.serial, signal)

                if (workers[device.serial].state === 'running') {
                    workers[device.serial].terminate()
                }
                return
            }

            if (code === 0) {
                log.info('Device worker "%s" stopped cleanly', device.serial)
            }

            onError(new procutil.ExitError(code))
        }

        if (!workers[device.serial]) {
            procutil.gracefullyKill(proc, options.killTimeout)
            onError(new Error('Device has been killed'))
            cleanup()
        }
        workers[device.serial].terminate = () => exitListener(0)

        const errorListener = (err: any) => {
            log.error('Device worker "%s" had an error: %s', device.serial, err?.message)
            onError(err)
        }

        const messageListener = (message: string) => {
            if (message !== 'ready') {
                log.warn('Unknown message from device worker "%s": "%s"', device.serial, message)
                return
            }

            onReady()
            proc.removeListener('message', messageListener)
        }

        proc.on('exit', exitListener)
        proc.on('error', errorListener)
        proc.on('message', messageListener)

        return {
            kill: () => {
                cleanup()

                log.info('Gracefully killing device worker "%s"', device.serial)
                return procutil.gracefullyKill(proc, options.killTimeout)
            }
        }
    }

    const work = async(device: ADBDevice) => {
        if (!workers[device.serial]) { // when device disconnected - stop restart loop
            return
        }

        log.info('Starting to work for device "%s"', device.serial)

        if (workers[device.serial].state !== 'starting') {
            workers[device.serial].state = 'starting'
            workers[device.serial].time = Date.now()
        }

        let resolveReady: () => void
        let rejectReady: () => void

        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve
            rejectReady = reject
        })
        const resolveRegister = () => {
            if (workers[device.serial]?.resolveRegister) {
                workers[device.serial].resolveRegister!()
                delete workers[device.serial].resolveRegister
            }
        }

        const handleError = async(err: any) => {
            log.error('Device "%s" error: %s', device.serial, err)
            rejectReady()
            resolveRegister()

            if (!workers[device.serial]) {
                // Device was disconnected, don't restart
                return
            }

            if (err instanceof procutil.ExitError) {
                log.error('Device worker "%s" died with code %s', device.serial, err.code)
                log.info('Restarting device worker "%s"', device.serial)

                await new Promise(r => setTimeout(r, 2000))
                if (!workers[device.serial]) {
                    log.info('Restart of device "%s" cancelled', device.serial)
                    return
                }

                work(device)
                return
            }
        }

        const worker = spawn(device, resolveReady!, handleError)
        if (!worker) {
            log.error('Device "%s" startup failed', device.serial)

            // Clean up worker and return ports
            if (workers[device.serial]) {
                resolveRegister()
                workers[device.serial]?.delete()
            }

            return
        }

        try {
            await Promise.all([
                workers[device.serial].register.then(() =>
                    log.info('Registered device "%s"', device.serial)
                ),
                ready.then(() =>
                    log.info('Device "%s" is ready', device.serial)
                )
            ])
        }
        catch (e: any) {
            log.error('Device "%s" startup failed: %s', device.serial, e?.message)

            // Clean up worker and return ports
            if (workers[device.serial]) {
                resolveRegister()
                await worker?.kill?.()
                workers[device.serial]?.delete()
            }
            return
        }

        if (!workers[device.serial]) { // when device disconnected - stop restart loop
            return
        }

        // Worker stop
        workers[device.serial].terminate = async() => {
            resolveRegister()

            workers[device.serial]?.delete()

            await worker?.kill?.() // if process exited - no effect
            log.info('Cleaning up device worker "%s"', device.serial)

            stats()

            // Wait while DeviceAbsentMessage processed on app side (1s)
            await new Promise(r => setTimeout(r, 1000))
        }

        workers[device.serial].state = 'running'

        stats()

        // Tell others the device state changed
        push.send([
            wireutil.global,
            wireutil.envelope(new wire.DeviceStatusMessage(device.serial, wireutil.toDeviceStatus(device.type)))
        ])
    }

    // Track and manage devices
    const tracker = new ADBObserver({
        intervalMs: 3000,
        port: options.adbPort,
        host: options.adbHost
    })

    // Worker health monitoring - check for stuck workers
    const checkWorkerHealth = async() => {
        const now = Date.now()
        const stuckWorkers: string[] = []

        for (const serial of Object.keys(workers)) {
            const worker = workers[serial]

            // Check if worker has been in "starting" state for longer than startup timeout
            if (worker.state === 'starting' && (now - worker.time) > STARTUP_TIMEOUT_MS) {
                log.warn('Worker "%s" has been stuck in starting state for %s ms', serial, now - worker.time)
                stuckWorkers.push(serial)
            }
        }

        // Stop and restart stuck workers
        for (const serial of stuckWorkers) {
            log.error('Restarting stuck worker "%s"', serial)

            try {
                const device = tracker.getDevice(serial)
                if (device) {
                    await removeDevice(device)
                }
            }
            catch (err) {
                log.error('Error restarting stuck worker "%s": %s', serial, err)
            }
        }
    }

    tracker.on('healthcheck', stats => {
        log.info('Healthcheck [OK: %s, BAD: %s]', stats.ok, stats.bad)
        checkWorkerHealth()
    })

    log.info('Tracking devices')

    tracker.on('connect', filterDevice((device) => {
        if (workers[device.serial]) {
            log.warn('Device has been connected twice. Skip.')
            return
        }

        log.info('Connected device "%s" [%s]', device.serial, device.type)

        workers[device.serial] = {
            state: 'waiting',
            time: Date.now(),
            terminate: () => {},
            register: register(device), // Register device immediately, before 'running' state
            ports: ports.splice(0, 2),
            delete: () => {
                log.warn('DELETING DEVICE %s', device.serial)
                ports.push(...workers[device.serial].ports)
                delete workers[device.serial]

                // Tell others the device is gone
                push.send([
                    wireutil.global,
                    wireutil.envelope(new wire.DeviceAbsentMessage(device.serial))
                ])
            }
        }

        stats()

        if (device.type === 'device') {
            work(device)
            return
        }

        // Try to reconnect device if it is not available for more than 30 seconds
        if (device.serial.includes(':') && workers[device.serial]) {
            workers[device.serial].waitingTimeoutTimer = setTimeout((serial) => {
                const device = tracker.getDevice(serial)
                if (device && !['device', 'emulator'].includes(device?.type)) {
                    device.reconnect()
                }
            }, 30_000, device.serial)
        }
    }))

    tracker.on('update', filterDevice(async(device, oldType) => {
        log.info('Device "%s" is now "%s" (was "%s")', device.serial, device.type, oldType)

        if (!['device', 'emulator'].includes(device.type)) {
            // Device went offline - stop worker but keep it in waiting state
            log.info('Device "%s" went offline [%s]', device.serial, device.type)

            if (workers[device.serial] && workers[device.serial].state !== 'waiting') {
                try {
                    await stop(device)
                }
                catch (err) {
                    log.error('Error stopping device worker "%s": %s', device.serial, err)
                }

                // Set back to waiting state (keep worker and ports allocated)
                if (workers[device.serial]) {
                    workers[device.serial].state = 'waiting'
                    workers[device.serial].time = Date.now()
                }
            }
            return
        }

        if (device.type === 'device' && workers[device.serial]?.state !== 'running') {
            clearTimeout(workers[device.serial].waitingTimeoutTimer)
            work(device)
        }
    }))

    tracker.on('stuck', async(device, health) => {
        log.warn(
            'Device %s is stuck [attempts: %s, first_healthcheck: %s, last_healthcheck: %s]',
            device.serial,
            new Date(health.firstFailureTime).toISOString(),
            new Date(health.lastAttemptTime).toISOString()
        )

        if (!workers[device.serial]) {
            log.warn('Device is stuck, but worker is not running')
            return
        }

        removeDevice(device)
    })

    tracker.on('disconnect', filterDevice(async(device) => {
        log.info('Device is disconnected "%s" [%s]', device.serial, device.type)

        if (!workers[device.serial]) {
            log.warn('Device is disconnected, but worker is not running%s', device.isStuck ? ' [Device got stuck earlier]' : '')
            return
        }

        if (!device.isStuck) {
            clearTimeout(workers[device.serial].waitingTimeoutTimer)
            removeDevice(device)
        }
    }))

    tracker.on('error', err => {
        log.error('ADBObserver error: %s', err?.message)
    })

    tracker.start()

    let statsTimer: NodeJS.Timeout
    const stats = (twice = true) => {
        const all = Object.keys(workers).length
        const result: any = {
            waiting: [],
            starting: [],
            running: []
        }
        for (const serial of Object.keys(workers)) {
            if (workers[serial].state === 'running') {
                result.running.push(serial)
            }
            else if (workers[serial].state === 'starting') {
                result.starting.push(serial)
            }
            else {
                result.waiting.push(serial)
            }
        }

        log.info(`Providing ${result.running.length} of ${all} device(s); starting: [${result.starting.join(', ')}], waiting: [${result.waiting.join(', ')}]`)
        log.info(`Providing all ${all} of ${tracker.count} device(s)`)
        log.info(`Providing all ${tracker.count} device(s)`)

        if (twice) {
            clearTimeout(statsTimer)
            statsTimer = setTimeout(stats, 10000, false)
        }
    }

    lifecycle.observe(async() => {
        // Clear timers
        clearTimeout(statsTimer)

        await Promise.all(
            Object.values(workers)
                .map(worker =>
                    worker.terminate()
                )
        )

        stats(false)
        tracker.destroy()

        ;[push, sub].forEach((sock) =>
            sock.close()
        )
    })
})
