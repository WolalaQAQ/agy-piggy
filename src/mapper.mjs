// @ts-check
/** 将 Antigravity Hook 载荷映射为稳定的 Piggy 工作事件，只提取标识、类型与时间。 */
import { closeSync, lstatSync, openSync, readSync } from 'node:fs'
import { createEventId, EVENT_FUTURE_MS, EVENT_MAX_AGE_MS } from './protocol.mjs'

const CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,160}$/
const DEFAULT_TAIL_BYTES = 262144
const FULL_READ_LIMIT = 4 * 1024 * 1024
const MAX_CACHED_CONVERSATIONS = 200
const IGNORED_PLAN_TOOLS = new Set(['exit_plan_mode', 'enter_plan_mode'])

/** @param {string} text @returns {any[]} */
function parseJsonlLines(text) {
  const steps = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) steps.push(parsed)
    } catch {}
  }
  return steps
}

/**
 * 仅读取 transcript.jsonl 尾部若干字节，避免长会话反复解析整份日志。
 * @param {string | undefined} transcriptPath
 * @param {number} [maxBytes]
 * @returns {any[]}
 */
export function readTranscriptTail(transcriptPath, maxBytes = DEFAULT_TAIL_BYTES) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return []
  let stat
  try {
    stat = lstatSync(transcriptPath)
  } catch {
    return []
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return []

  const readRange = (offset, length) => {
    const fd = openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(length)
      const bytesRead = readSync(fd, buf, 0, length, offset)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      closeSync(fd)
    }
  }

  const start = Math.max(0, stat.size - maxBytes)
  let raw = readRange(start, stat.size - start)
  if (start > 0) {
    const firstNewline = raw.indexOf('\n')
    raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : ''
  }
  let steps = parseJsonlLines(raw)
  if (start > 0 && steps.length === 0 && stat.size <= FULL_READ_LIMIT) {
    steps = parseJsonlLines(readRange(0, stat.size))
  }
  return steps
}

/** @template T @param {Record<string, T>} record @param {string} key @param {T} value */
function rememberKey(record, key, value, maxKeys = MAX_CACHED_CONVERSATIONS) {
  delete record[key]
  record[key] = value
  const keys = Object.keys(record)
  if (keys.length > maxKeys) {
    for (const oldKey of keys.slice(0, keys.length - maxKeys)) {
      delete record[oldKey]
    }
  }
}

/** @param {string | undefined} isoTime @param {number} nowMs */
function parseReasonableTime(isoTime, nowMs) {
  if (typeof isoTime !== 'string' || !isoTime) return nowMs
  const ms = Date.parse(isoTime)
  if (!Number.isFinite(ms) || ms < 0) return nowMs
  const truncated = Math.trunc(ms)
  if (truncated < nowMs - EVENT_MAX_AGE_MS || truncated > nowMs + EVENT_FUTURE_MS) return nowMs
  return truncated
}

/**
 * 将单次 Hook stdin 载荷映射为事件；无法映射或已去重时返回 event: undefined。
 * @param {any} input
 * @param {{userSteps: Record<string, number>, stopAnchors: Record<string, string>}} state
 * @param {number} [nowMs]
 * @returns {{event: import('./protocol.mjs').WorkEvent | undefined, stateChanged: boolean}}
 */
export function mapHookInput(input, state, nowMs = Date.now()) {
  const conversationId = typeof input?.conversationId === 'string' && CONVERSATION_ID.test(input.conversationId)
    ? input.conversationId
    : ''
  if (!conversationId) return { event: undefined, stateChanged: false }

  const hookEventName = input?.hookEventName
  if (hookEventName === 'PreInvocation') {
    const steps = readTranscriptTail(input.transcriptPath)
    let latestUserStep
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT' &&
          Number.isSafeInteger(step.step_index) && step.step_index >= 0) {
        latestUserStep = step
        break
      }
    }
    if (!latestUserStep || state.userSteps[conversationId] === latestUserStep.step_index) {
      return { event: undefined, stateChanged: false }
    }
    rememberKey(state.userSteps, conversationId, latestUserStep.step_index)
    const at = parseReasonableTime(latestUserStep.created_at, nowMs)
    return {
      event: { id: createEventId(['message', conversationId, latestUserStep.step_index]), type: 'message', at },
      stateChanged: true,
    }
  }

  if (hookEventName === 'PostToolUse') {
    const toolCall = input?.toolCall
    const toolName = typeof toolCall?.name === 'string' ? toolCall.name.trim() : ''
    if (!toolName || IGNORED_PLAN_TOOLS.has(toolName)) return { event: undefined, stateChanged: false }
    const callId = typeof toolCall?.id === 'string' ? toolCall.id.trim() : ''
    const anchor = callId
      ? `id:${callId}`
      : (Number.isSafeInteger(input?.stepIdx) ? `step:${input.stepIdx}` : '')
    if (!anchor) return { event: undefined, stateChanged: false }
    const isError = typeof input?.error === 'string' && input.error.trim() !== ''
    const type = isError ? 'toolError' : 'tool'
    return {
      event: { id: createEventId(['tool', conversationId, anchor]), type, at: nowMs },
      stateChanged: false,
    }
  }

  if (hookEventName === 'Stop') {
    const reason = typeof input?.terminationReason === 'string' ? input.terminationReason : ''
    let type
    if (reason === 'ERROR') {
      type = 'agentError'
    } else if (reason === 'NO_TOOL_CALL' && input?.fullyIdle !== false) {
      type = 'turn'
    } else {
      return { event: undefined, stateChanged: false }
    }

    const steps = readTranscriptTail(input.transcriptPath)
    let lastStepIndex
    for (let i = steps.length - 1; i >= 0; i--) {
      if (Number.isSafeInteger(steps[i].step_index) && steps[i].step_index >= 0) {
        lastStepIndex = steps[i].step_index
        break
      }
    }
    const anchor = lastStepIndex !== undefined
      ? `step:${lastStepIndex}`
      : `exec:${String(input?.initialNumSteps ?? 0)}:${String(input?.executionNum ?? 0)}`
    const dedupValue = `${type}:${anchor}`
    if (state.stopAnchors[conversationId] === dedupValue) {
      return { event: undefined, stateChanged: false }
    }
    rememberKey(state.stopAnchors, conversationId, dedupValue)
    return {
      event: { id: createEventId(['stop', conversationId, type, anchor]), type, at: nowMs },
      stateChanged: true,
    }
  }

  return { event: undefined, stateChanged: false }
}
