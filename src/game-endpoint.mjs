// @ts-check
/** 官方 dsh-piggy 本机工作事件 HTTP 客户端。 */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { WORK_EVENT_SOURCE } from './protocol.mjs'
import { verifyPrivateWorkFileAsync } from './work-files.mjs'

const JSON_LIMIT = 1024
const DEFAULT_REQUEST_MS = 10000
const DEFAULT_HEALTH_MS = 5000

/** @typedef {{directory: string, port: number, token: string}} GameEndpoint */

/** @param {string} directory @param {Record<string, string>} [verifiedCache] @returns {Promise<GameEndpoint>} */
async function readEndpointFile(directory, verifiedCache) {
  const filePath = join(directory, 'endpoint.json')
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JSON_LIMIT) {
    throw new Error('invalid game endpoint discovery')
  }
  await verifyPrivateWorkFileAsync(filePath, verifiedCache)
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let value
  try {
    const data = Buffer.alloc(JSON_LIMIT + 1)
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    if (bytesRead > JSON_LIMIT) throw new Error('invalid game endpoint discovery')
    value = JSON.parse(data.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await file.close()
  }
  if (!value || value.version !== 1 || value.role !== 'piggy-work-events' || !Number.isInteger(value.port) ||
      value.port < 1 || value.port > 65535 || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) {
    throw new Error('invalid game endpoint discovery')
  }
  return { directory, port: value.port, token: value.token }
}

/**
 * 按候选顺序发现有效的游戏工作接口；目录不存在时继续查下一候选，若均未就绪返回 null。
 * @param {string[]} directories
 * @param {Record<string, string>} [verifiedCache]
 * @returns {Promise<GameEndpoint | null>}
 */
export async function discoverEndpoint(directories, verifiedCache) {
  for (const directory of directories) {
    try {
      return await readEndpointFile(directory, verifiedCache)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      throw error
    }
  }
  return null
}

/**
 * 只读健康检查。
 * @param {GameEndpoint} endpoint
 * @param {number} [timeoutMs]
 */
export async function checkHealth(endpoint, timeoutMs = DEFAULT_HEALTH_MS) {
  let deadline
  return new Promise((resolvePromise, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path: '/health',
      method: 'GET',
      agent: false,
      maxHeaderSize: 4096,
      headers: { authorization: `Bearer ${endpoint.token}` },
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > JSON_LIMIT) { req.destroy(new Error('invalid game response')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        if (response.statusCode !== 200) {
          return reject(Object.assign(new Error(`game status ${response.statusCode}`), { status: response.statusCode }))
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || value.ok !== true || value.role !== 'piggy-work-events') {
            throw new Error('invalid game response')
          }
          resolvePromise(value)
        } catch {
          reject(new Error('invalid game response'))
        }
      })
    })
    deadline = setTimeout(() => req.destroy(new Error('game timeout')), timeoutMs)
    req.once('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end()
  }).finally(() => clearTimeout(deadline))
}

/** @param {string | string[] | undefined} headerValue */
function parseRetryAfterMs(headerValue) {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10)
  const seconds = Number.isFinite(parsed) && parsed > 0 ? Math.min(3600, parsed) : 60
  return seconds * 1000
}

/**
 * 向游戏提交单条工作事件。
 * @param {GameEndpoint} endpoint
 * @param {import('./protocol.mjs').WorkEvent} event
 * @param {{timeoutMs?: number}} [options]
 */
export async function postWorkEvent(endpoint, event, options = {}) {
  const payload = JSON.stringify({
    version: 1,
    source: WORK_EVENT_SOURCE,
    id: event.id,
    type: event.type,
    at: event.at,
  })
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_MS
  let deadline
  return new Promise((resolvePromise, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path: '/events',
      method: 'POST',
      agent: false,
      maxHeaderSize: 4096,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > JSON_LIMIT) { req.destroy(new Error('invalid game response')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        if (response.statusCode === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers['retry-after'])
          return reject(Object.assign(new Error('game rate limited'), { status: 429, retryAfterMs }))
        }
        if (response.statusCode !== 200) {
          return reject(Object.assign(new Error(`game status ${response.statusCode}`), { status: response.statusCode }))
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '') ||
              !value || value.ok !== true || !['applied', 'duplicate', 'ignored'].includes(value.status)) {
            throw new Error('invalid game response')
          }
          resolvePromise(value)
        } catch {
          reject(new Error('invalid game response'))
        }
      })
    })
    deadline = setTimeout(() => req.destroy(new Error('game timeout')), timeoutMs)
    req.once('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end(payload)
  }).finally(() => clearTimeout(deadline))
}
