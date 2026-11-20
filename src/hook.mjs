// @ts-check
/** Antigravity Hook 主入口与后台 --flush 投递入口。 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapHookInput } from './mapper.mjs'
import {
  enqueueSync,
  flushOutboxAsync,
  readCursors,
  readState,
  shouldSpawnFlush,
  writeCursors,
  writeLog,
  writeState,
} from './outbox.mjs'
import { loadPluginConfig, resolveDataDirectory, resolveGameDirectories } from './paths.mjs'

const SELF_FILE = fileURLToPath(import.meta.url)
const PLUGIN_ROOT = resolve(dirname(SELF_FILE), '..')

function readStdinUtf8() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function runHookMain() {
  let response = {}
  let dataDir = ''
  try {
    const raw = readStdinUtf8()
    let input = {}
    try {
      input = raw ? JSON.parse(raw) : {}
    } catch {
      input = {}
    }
    if (input?.hookEventName === 'Stop') {
      response = { decision: 'allow' }
    }

    if (process.env.AGY_PIGGY_DISABLED === '1') return
    const config = loadPluginConfig(PLUGIN_ROOT)
    if (!config.enabled) return

    dataDir = resolveDataDirectory({ directory: config.directory })
    const nowMs = Date.now()
    const cursors = readCursors(dataDir)
    const { event, stateChanged } = mapHookInput(input, cursors, nowMs)
    if (stateChanged) {
      writeCursors(dataDir, cursors)
    }

    let enqueuedNew = false
    if (event) {
      enqueueSync(dataDir, event)
      enqueuedNew = true
    }

    const state = readState(dataDir)
    const shouldFlush = shouldSpawnFlush(dataDir, state, enqueuedNew, nowMs)
    if (shouldFlush) {
      state.lastFlushAttemptAt = nowMs
      writeState(dataDir, state)
      const child = spawn(process.execPath, [SELF_FILE, '--flush'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      })
      child.unref()
    }
  } catch (error) {
    if (dataDir) {
      const msg = error instanceof Error ? error.message : 'hook failure'
      writeLog(dataDir, `Hook 处理失败：${msg}`)
    }
  } finally {
    process.stdout.write(`${JSON.stringify(response)}\n`)
    process.exitCode = 0
  }
}

async function runFlushMain() {
  let dataDir = ''
  try {
    if (process.env.AGY_PIGGY_DISABLED === '1') return
    const config = loadPluginConfig(PLUGIN_ROOT)
    if (!config.enabled) return
    dataDir = resolveDataDirectory({ directory: config.directory })
    const gameDirectories = resolveGameDirectories({ gameDirectory: config.gameDirectory })
    await flushOutboxAsync({ dataDir, gameDirectories })
  } catch (error) {
    if (dataDir) {
      const msg = error instanceof Error ? error.message : 'flush failure'
      writeLog(dataDir, `后台投递失败：${msg}`)
    }
  }
}

if (process.argv.includes('--flush')) {
  void runFlushMain()
} else {
  runHookMain()
}
