// @ts-check
/** 本地持久发件箱、Hook 游标状态、单实例后台投递锁与日志。 */
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { lstat, open, opendir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { checkHealth, discoverEndpoint, postWorkEvent } from './game-endpoint.mjs'
import { validateWorkEvent } from './protocol.mjs'
import { secureWorkDirectoryAsync } from './work-files.mjs'

const MAX_LOG_BYTES = 262144
const MAX_STATE_BYTES = 262144
const MAX_EVENT_BYTES = 1024
const LOCK_STALE_MS = 60000
const BACKLOG_RETRY_COOLDOWN_MS = 15000
const MAX_SCAN_PER_PASS = 4096
const EVENT_FILE_NAME = /^[a-f0-9]{64}\.json$/

/** @typedef {{userSteps: Record<string, number>, stopAnchors: Record<string, string>}} CursorState */
/** @typedef {{backoffUntil: number, lastFlushAttemptAt: number, verifiedPaths: Record<string, string>}} DeliveryState */

/** @returns {CursorState} */
function defaultCursors() {
  return {
    userSteps: {},
    stopAnchors: {},
  }
}

/** @returns {DeliveryState} */
function defaultState() {
  return {
    backoffUntil: 0,
    lastFlushAttemptAt: 0,
    verifiedPaths: {},
  }
}

/** @param {string} dataDir @param {string} message */
export function writeLog(dataDir, message) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const logPath = join(dataDir, 'agy-piggy.log')
    try {
      const st = statSync(logPath)
      if (st.size > MAX_LOG_BYTES) {
        const raw = readFileSync(logPath, 'utf8')
        const half = raw.slice(Math.floor(raw.length / 2))
        const nl = half.indexOf('\n')
        writeFileSync(logPath, nl >= 0 ? half.slice(nl + 1) : half, 'utf8')
      }
    } catch {}
    appendFileSync(logPath, `${new Date().toISOString()} [agy-piggy] ${message}\n`, 'utf8')
  } catch {}
}

/** @param {string} filePath @param {unknown} value */
function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmpPath, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value), 'utf8')
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmpPath, filePath)
  } catch (error) {
    try { unlinkSync(tmpPath) } catch {}
    throw error
  }
}

/** @param {string} dataDir @returns {CursorState} */
export function readCursors(dataDir) {
  const filePath = join(dataDir, 'cursors.json')
  try {
    const st = lstatSync(filePath)
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_STATE_BYTES) return defaultCursors()
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultCursors()
    return {
      userSteps: raw.userSteps && typeof raw.userSteps === 'object' && !Array.isArray(raw.userSteps) ? raw.userSteps : {},
      stopAnchors: raw.stopAnchors && typeof raw.stopAnchors === 'object' && !Array.isArray(raw.stopAnchors) ? raw.stopAnchors : {},
    }
  } catch {
    return defaultCursors()
  }
}

/** @param {string} dataDir @param {CursorState} cursors */
export function writeCursors(dataDir, cursors) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  writeJsonAtomic(join(dataDir, 'cursors.json'), cursors)
}

/** @param {string} dataDir @returns {DeliveryState} */
export function readState(dataDir) {
  const filePath = join(dataDir, 'state.json')
  try {
    const st = lstatSync(filePath)
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_STATE_BYTES) return defaultState()
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultState()
    return {
      backoffUntil: Number.isFinite(raw.backoffUntil) ? raw.backoffUntil : 0,
      lastFlushAttemptAt: Number.isFinite(raw.lastFlushAttemptAt) ? raw.lastFlushAttemptAt : 0,
      verifiedPaths: raw.verifiedPaths && typeof raw.verifiedPaths === 'object' && !Array.isArray(raw.verifiedPaths) ? raw.verifiedPaths : {},
    }
  } catch {
    return defaultState()
  }
}

/** @param {string} dataDir @param {DeliveryState} state */
export function writeState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  writeJsonAtomic(join(dataDir, 'state.json'), state)
}

/**
 * 在 Hook 同步阶段将工作事件原子写入发件箱，不等待网络请求。
 * @param {string} dataDir
 * @param {import('./protocol.mjs').WorkEvent} event
 */
export function enqueueSync(dataDir, event) {
  validateWorkEvent(event, Date.now())
  const eventsDir = join(dataDir, 'events')
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 })
  const target = join(eventsDir, `${event.id}.json`)
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const payload = JSON.stringify({ id: event.id, type: event.type, at: event.at })
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, payload, 'utf8')
  } finally {
    closeSync(fd)
  }
  try {
    try {
      linkSync(tmp, target)
    } catch (error) {
      if (error?.code === 'EEXIST') return
      // 跨文件系统或不支持硬链时回退 wx 直写。
      try {
        const directFd = openSync(target, 'wx', 0o600)
        try { writeFileSync(directFd, payload, 'utf8') } finally { closeSync(directFd) }
      } catch (directError) {
        if (directError?.code !== 'EEXIST') throw directError
      }
    }
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

/** @param {string} dataDir @returns {boolean} */
export function hasPendingEventsSync(dataDir) {
  const eventsDir = join(dataDir, 'events')
  try {
    for (const name of readdirSync(eventsDir)) {
      if (EVENT_FILE_NAME.test(name)) return true
    }
  } catch {}
  return false
}

/** @param {number} pid */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** @param {string} dataDir @param {number} nowMs */
function isFlushLockActive(dataDir, nowMs) {
  const lockPath = join(dataDir, 'flush.lock')
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof raw?.startedAt === 'number' && nowMs - raw.startedAt > LOCK_STALE_MS) return false
    return isProcessAlive(raw?.pid)
  } catch {
    return false
  }
}

/**
 * 判断 Hook 退出前是否需要派生后台 --flush 投递进程。
 * @param {string} dataDir
 * @param {DeliveryState} state
 * @param {boolean} enqueuedNew
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function shouldSpawnFlush(dataDir, state, enqueuedNew, nowMs = Date.now()) {
  if (nowMs < (state.backoffUntil || 0)) return false
  if (isFlushLockActive(dataDir, nowMs)) return false
  if (enqueuedNew) return true
  if (nowMs - (state.lastFlushAttemptAt || 0) < BACKLOG_RETRY_COOLDOWN_MS) return false
  return hasPendingEventsSync(dataDir)
}

/** @param {string} dataDir */
function acquireFlushLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const lockPath = join(dataDir, 'flush.lock')
  const token = randomBytes(8).toString('hex')
  const body = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try { writeFileSync(fd, body, 'utf8') } finally { closeSync(fd) }
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8'))
          if (current?.token === token) unlinkSync(lockPath)
        } catch {}
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let shouldReclaim = false
      try {
        const existing = JSON.parse(readFileSync(lockPath, 'utf8'))
        const ageMs = Date.now() - Number(existing?.startedAt || 0)
        if (ageMs > LOCK_STALE_MS || !isProcessAlive(existing?.pid)) shouldReclaim = true
      } catch {
        try {
          const st = statSync(lockPath)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) shouldReclaim = true
        } catch {
          shouldReclaim = true
        }
      }
      if (!shouldReclaim) return null
      try { unlinkSync(lockPath) } catch {}
    }
  }
  return null
}

/** @param {string} filePath */
async function readEventFileAsync(filePath) {
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVENT_BYTES) {
    throw new Error('invalid event file')
  }
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const data = Buffer.alloc(MAX_EVENT_BYTES + 1)
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    if (bytesRead > MAX_EVENT_BYTES) throw new Error('event file too large')
    return JSON.parse(data.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await file.close()
  }
}

/** @param {string} filePath */
async function removeFileSafe(filePath) {
  try {
    await unlink(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** @param {unknown} error */
function describeDeliveryError(error) {
  if (['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(/** @type {any} */ (error)?.code)) {
    return /** @type {any} */ (error).code
  }
  if (typeof /** @type {any} */ (error)?.status === 'number') {
    return `HTTP ${/** @type {any} */ (error).status}`
  }
  if (error instanceof Error && error.message === 'game timeout') return '请求超时'
  return '投递失败'
}

/**
 * 后台排干本地发件箱中的所有待投事件。
 * @param {{dataDir: string, gameDirectories: string[], timeoutMs?: number}} options
 */
export async function flushOutboxAsync(options) {
  const { dataDir, gameDirectories, timeoutMs } = options
  const releaseLock = acquireFlushLock(dataDir)
  if (!releaseLock) return { sent: 0, skipped: true }

  let sent = 0
  try {
    const state = readState(dataDir)
    const nowMs = Date.now()
    if (nowMs < (state.backoffUntil || 0)) {
      return { sent: 0, backoffUntil: state.backoffUntil }
    }

    const eventsDir = join(dataDir, 'events')
    await secureWorkDirectoryAsync(dataDir, state.verifiedPaths)
    await secureWorkDirectoryAsync(eventsDir, state.verifiedPaths)
    state.lastFlushAttemptAt = Date.now()

    if (!hasPendingEventsSync(dataDir)) {
      writeState(dataDir, state)
      return { sent: 0 }
    }

    const endpoint = await discoverEndpoint(gameDirectories, state.verifiedPaths)
    if (!endpoint) {
      writeState(dataDir, state)
      return { sent: 0, missingEndpoint: true }
    }

    await checkHealth(endpoint, timeoutMs ?? 5000)

    let reportedExpired = false
    for (let pass = 0; pass < 2; pass++) {
      let deliveredInPass = 0
      let abortedPass = false
      let scanned = 0
      const reader = await opendir(eventsDir)
      try {
        while (scanned++ < MAX_SCAN_PER_PASS) {
          const entry = await reader.read()
          if (!entry) break
          if (!EVENT_FILE_NAME.test(entry.name)) continue
          const filePath = join(eventsDir, entry.name)
          let event
          try {
            event = await readEventFileAsync(filePath)
            validateWorkEvent(event, Date.now())
            if (`${event.id}.json` !== entry.name) throw new Error('invalid event identity')
          } catch (error) {
            if (error?.code === 'ENOENT') continue
            if (error?.status === 422 && error?.code === 'EXPIRED' && `${event?.id}.json` === entry.name) {
              if (!reportedExpired) {
                writeLog(dataDir, '发件箱存在超过七天接收窗口的事件，已保留，不再自动投递')
                reportedExpired = true
              }
              continue
            }
            writeLog(dataDir, `发件箱记录校验失败，已保留：${describeDeliveryError(error)}`)
            continue
          }

          try {
            await postWorkEvent(endpoint, event, { timeoutMs })
            await removeFileSafe(filePath)
            sent++
            deliveredInPass++
          } catch (error) {
            if (error?.status === 429) {
              state.backoffUntil = Date.now() + Number(error.retryAfterMs || 60000)
              writeLog(dataDir, `收到游戏 429 限流，已按 Retry-After 退避至 ${new Date(state.backoffUntil).toISOString()}`)
              abortedPass = true
              break
            }
            if (error?.status === 422 || error?.status === 409) {
              writeLog(dataDir, `事件被游戏拒绝（${describeDeliveryError(error)}），已保留现场`)
              continue
            }
            writeLog(dataDir, `游戏投递暂不可用，等待下次重试：${describeDeliveryError(error)}`)
            abortedPass = true
            break
          }
        }
      } finally {
        await reader.close()
      }
      if (abortedPass || deliveredInPass === 0) break
    }

    writeState(dataDir, state)
    return { sent }
  } catch (error) {
    if (existsSync(dataDir)) {
      writeLog(dataDir, `后台投递异常：${describeDeliveryError(error)}`)
    }
    return { sent, error: true }
  } finally {
    releaseLock()
  }
}
