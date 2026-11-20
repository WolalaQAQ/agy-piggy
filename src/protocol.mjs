// @ts-check
/** 官方工作事件协议约束与稳定标识生成。 */
import { createHash } from 'node:crypto'

export const WORK_EVENT_SOURCE = 'antigravity'
export const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const EVENT_FUTURE_MS = 5 * 60 * 1000
export const WORK_ID = /^[a-f0-9]{64}$/
export const EVENT_TYPES = new Set(['message', 'turn', 'tool', 'toolError', 'agentError'])

/** @typedef {{id: string, type: 'message'|'turn'|'tool'|'toolError'|'agentError', at: number}} WorkEvent */

/** @param {string} reason @param {number} status @param {string} [code] */
export function workError(reason, status, code) {
  return Object.assign(new Error(reason), { status, ...(code ? { code } : {}) })
}

/** @param {unknown[]} parts @returns {string} */
export function createEventId(parts) {
  return createHash('blake2s256').update(JSON.stringify(['agy-piggy:v1', ...parts])).digest('hex')
}

/** @param {unknown} value @param {number} [nowMs] @returns {asserts value is WorkEvent} */
export function validateWorkEvent(value, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workError('invalid event', 400)
  const event = /** @type {Record<string, any>} */ (value)
  if (Object.keys(event).sort().join(',') !== 'at,id,type' || typeof event.id !== 'string' ||
      !WORK_ID.test(event.id) || !EVENT_TYPES.has(event.type) || !Number.isSafeInteger(event.at) || event.at < 0) {
    throw workError('invalid event', 400)
  }
  if (nowMs !== undefined) {
    if (event.at < nowMs - EVENT_MAX_AGE_MS) throw workError('event outside receipt window', 422, 'EXPIRED')
    if (event.at > nowMs + EVENT_FUTURE_MS) throw workError('event from future', 422, 'FUTURE')
  }
}
