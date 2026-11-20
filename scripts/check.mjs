// @ts-check
/** agy-piggy 语法校验、清单检查与端到端隔离闭环验证。 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHealth, discoverEndpoint } from '../src/game-endpoint.mjs'
import { resolveGameDirectories } from '../src/paths.mjs'
import { createEventId, WORK_EVENT_SOURCE } from '../src/protocol.mjs'
import { flushOutboxAsync, readState, shouldSpawnFlush } from '../src/outbox.mjs'
import { secureWorkDirectoryAsync } from '../src/work-files.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK_SCRIPT = join(REPO_ROOT, 'src', 'hook.mjs')
const ALLOWED_PLUGIN_KEYS = new Set([
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'logo',
  'suggestedPrompts',
  'disabled',
])

function checkSyntax() {
  const dirs = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'scripts')]
  let checked = 0
  for (const dir of dirs) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.mjs')) continue
      execFileSync(process.execPath, ['--check', join(dir, file)], { encoding: 'utf8' })
      checked++
    }
  }
  return checked
}

function scanSensitiveStrings(dir) {
  const patterns = [
    new RegExp('695' + '46'),
    new RegExp('[cC]:[\\\\/]+' + 'Users[\\\\/]+'),
    new RegExp('gh[op]_' + '[A-Za-z0-9]{20,}'),
  ]
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanSensitiveStrings(fullPath)
      continue
    }
    const text = readFileSync(fullPath, 'utf8')
    for (const pattern of patterns) {
      assert.equal(pattern.test(text), false, `检测到敏感或本机路径字面量：${fullPath}`)
    }
  }
}

function checkManifests() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin.json'), 'utf8'))
  assert.equal(pkg.name, 'agy-piggy')
  assert.equal(plugin.name, 'agy-piggy')
  assert.equal(pkg.version, plugin.version, 'package.json 与 plugin.json 版本不一致')
  for (const key of Object.keys(plugin)) {
    assert.ok(ALLOWED_PLUGIN_KEYS.has(key), `plugin.json 包含未授权顶层字段：${key}`)
  }
  if (plugin.logo) {
    assert.ok(existsSync(join(REPO_ROOT, plugin.logo)), `logo 文件不存在：${plugin.logo}`)
  }

  const hooks = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks.json'), 'utf8'))
  const spec = hooks['agy-piggy']
  assert.ok(spec && spec.enabled === true)
  assert.equal(spec.PreInvocation?.[0]?.command, 'node ./src/hook.mjs')
  assert.equal(spec.PostToolUse?.[0]?.hooks?.[0]?.command, 'node ./src/hook.mjs')
  assert.equal(spec.Stop?.[0]?.command, 'node ./src/hook.mjs')

  scanSensitiveStrings(REPO_ROOT)

  const val = spawnSync('agy', ['plugin', 'validate', REPO_ROOT, '--strict', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (!val.error || val.error.code !== 'ENOENT') {
    assert.equal(val.status, 0, `agy plugin validate --strict 失败：${val.stdout || val.stderr}`)
    const report = JSON.parse(val.stdout)
    assert.deepEqual(report.findings ?? [], [], `agy plugin validate 存在发现项：${val.stdout}`)
  }
}

async function startMockGameServer(token) {
  /** @type {Array<{version:number,source:string,id:string,type:string,at:number}>} */
  const received = []
  const seen = new Set()
  let forceRateLimit = false

  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, reason: 'unauthorized' }))
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, role: 'piggy-work-events', version: 1 }))
      return
    }
    if (req.method === 'POST' && req.url === '/events') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        if (forceRateLimit) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
          res.end(JSON.stringify({ ok: false, reason: 'rate limited' }))
          return
        }
        const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const key = `${event.source}:${event.id}`
        const isDup = seen.has(key)
        if (!isDup) {
          seen.add(key)
          received.push(event)
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, status: isDup ? 'duplicate' : 'applied', disposition: 'applied' }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    port: address.port,
    received,
    setRateLimit(flag) { forceRateLimit = flag },
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  }
}

function runHookProcess(payload, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      try {
        assert.equal(code, 0, `Hook 退出码非 0：${stderr}`)
        assert.equal(stderr, '', `Hook 不应输出 stderr：${stderr}`)
        resolvePromise(stdout.trim())
      } catch (err) {
        reject(err)
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

function runFlushProcess(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, '--flush'], {
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      try {
        assert.equal(code, 0, `Flush 退出码非 0：${stderr}`)
        resolvePromise(undefined)
      } catch (err) {
        reject(err)
      }
    })
  })
}

/** 等待由 Hook 异步派生的后台 --flush 进程释放锁并退出，避免测试竞态或残留占用。 */
async function waitForFlushIdle(dataDir, timeoutMs = 10000) {
  const lockPath = join(dataDir, 'flush.lock')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error('等待后台 --flush 进程释放 flush.lock 超时')
}

async function runIntegration() {
  const tmpBase = process.env.AGY_PIGGY_TEST_TMP || tmpdir()
  mkdirSync(tmpBase, { recursive: true })
  const root = mkdtempSync(join(tmpBase, 'agy-piggy-check-'))
  const token = 'a'.repeat(64)
  const server = await startMockGameServer(token)

  try {
    const userData = join(root, 'piggy-userdata')
    const archiveDir = join(userData, 'owner-archives', 'archive-test')
    const ownerDocPath = join(archiveDir, 'owner-document.json')
    const workEventsDir = `${ownerDocPath}.work-events`
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(ownerDocPath, '{}', 'utf8')
    writeFileSync(
      join(userData, 'owner-archive-selection.json'),
      JSON.stringify({
        version: 1,
        active: { ownerDocumentPath: ownerDocPath, ownerId: 'owner-1', pigId: 'pig-1' },
        pending: null,
      }),
      'utf8'
    )

    // 1. 验证 OwnerDocument 发现顺序与健康检查
    await secureWorkDirectoryAsync(workEventsDir)
    const endpointFile = join(workEventsDir, 'endpoint.json')
    writeFileSync(
      endpointFile,
      JSON.stringify({ version: 1, role: 'piggy-work-events', port: server.port, token, pid: process.pid }),
      { encoding: 'utf8', mode: 0o600 }
    )

    const discoveredDirs = resolveGameDirectories({ env: { PIGGY_USERDATA: userData } })
    assert.equal(discoveredDirs[0], workEventsDir)
    const endpoint = await discoverEndpoint(discoveredDirs)
    assert.ok(endpoint && endpoint.port === server.port)
    const health = await checkHealth(endpoint)
    assert.equal(health.ok, true)

    // 移除 endpoint.json 以测试离线入队
    rmSync(endpointFile)

    const dataDir = join(root, 'plugin-data')
    const testEnv = {
      PLUGIN_DATA: dataDir,
      PIGGY_USERDATA: userData,
      AGY_PIGGY_DATA_DIR: '',
      AGY_PIGGY_GAME_ENDPOINT: '',
      PIGGY_OWNER_DOCUMENT_CONFIG: '',
    }

    const mainConv = 'conv-main-01'
    const mainTranscript = join(root, 'main-transcript.jsonl')
    const userTs = new Date(Date.now() - 5000).toISOString()
    writeFileSync(
      mainTranscript,
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: userTs }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE' }),
      ].join('\n') + '\n',
      'utf8'
    )

    // 同一 USER_INPUT 连续两次 PreInvocation，只产 1 条 message
    assert.equal(await runHookProcess({ hookEventName: 'PreInvocation', conversationId: mainConv, transcriptPath: mainTranscript }, testEnv), '{}')
    assert.equal(await runHookProcess({ hookEventName: 'PreInvocation', conversationId: mainConv, transcriptPath: mainTranscript }, testEnv), '{}')

    // 子代理会话仅有 SYSTEM_MESSAGE，产生 0 条 message
    const subTranscript = join(root, 'sub-transcript.jsonl')
    writeFileSync(subTranscript, JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE' }) + '\n', 'utf8')
    assert.equal(await runHookProcess({ hookEventName: 'PreInvocation', conversationId: 'conv-sub-01', transcriptPath: subTranscript }, testEnv), '{}')

    // PostToolUse：tool、toolError、以及忽略 exit_plan_mode
    assert.equal(await runHookProcess({
      hookEventName: 'PostToolUse',
      conversationId: mainConv,
      stepIdx: 2,
      toolCall: { id: 'call_1', name: 'run_command' },
    }, testEnv), '{}')
    assert.equal(await runHookProcess({
      hookEventName: 'PostToolUse',
      conversationId: mainConv,
      stepIdx: 3,
      toolCall: { id: 'call_2', name: 'read_file' },
      error: 'ENOENT',
    }, testEnv), '{}')
    assert.equal(await runHookProcess({
      hookEventName: 'PostToolUse',
      conversationId: mainConv,
      stepIdx: 4,
      toolCall: { id: 'call_3', name: 'exit_plan_mode' },
    }, testEnv), '{}')

    // Stop：忽略 fullyIdle:false 与 TERMINAL_STEP_TYPE，仅计 NO_TOOL_CALL + ERROR
    assert.equal(await runHookProcess({
      hookEventName: 'Stop',
      conversationId: mainConv,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: false,
      transcriptPath: mainTranscript,
    }, testEnv), '{"decision":"allow"}')
    assert.equal(await runHookProcess({
      hookEventName: 'Stop',
      conversationId: mainConv,
      terminationReason: 'TERMINAL_STEP_TYPE',
      fullyIdle: true,
      transcriptPath: mainTranscript,
    }, testEnv), '{"decision":"allow"}')
    assert.equal(await runHookProcess({
      hookEventName: 'Stop',
      conversationId: mainConv,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      transcriptPath: mainTranscript,
    }, testEnv), '{"decision":"allow"}')
    // 同一 step 不重复产出 turn
    assert.equal(await runHookProcess({
      hookEventName: 'Stop',
      conversationId: mainConv,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      transcriptPath: mainTranscript,
    }, testEnv), '{"decision":"allow"}')
    // ERROR 记为 agentError
    assert.equal(await runHookProcess({
      hookEventName: 'Stop',
      conversationId: mainConv,
      terminationReason: 'ERROR',
      fullyIdle: true,
      transcriptPath: mainTranscript,
    }, testEnv), '{"decision":"allow"}')

    const eventsDir = join(dataDir, 'events')
    await waitForFlushIdle(dataDir)
    const pendingBefore = readdirSync(eventsDir).filter(f => f.endsWith('.json'))
    assert.equal(pendingBefore.length, 5, `离线待投事件应为 5 条，实际为 ${pendingBefore.length}`)

    // 2. 写入 endpoint.json 并执行后台补投
    writeFileSync(
      endpointFile,
      JSON.stringify({ version: 1, role: 'piggy-work-events', port: server.port, token, pid: process.pid }),
      { encoding: 'utf8', mode: 0o600 }
    )
    await runFlushProcess(testEnv)
    await waitForFlushIdle(dataDir)

    const pendingAfter = readdirSync(eventsDir).filter(f => f.endsWith('.json'))
    assert.equal(pendingAfter.length, 0, '补投完成后发件箱应清空')
    assert.equal(server.received.length, 5)
    assert.deepEqual(
      server.received.map(e => e.type).sort(),
      ['agentError', 'message', 'tool', 'toolError', 'turn']
    )
    assert.ok(server.received.every(e => e.source === WORK_EVENT_SOURCE && e.version === 1))

    // 3. 验证 429 Retry-After 退避与过期事件保留
    server.setRateLimit(true)
    assert.equal(await runHookProcess({
      hookEventName: 'PostToolUse',
      conversationId: mainConv,
      stepIdx: 9,
      toolCall: { id: 'call_rate_limit', name: 'write_file' },
    }, testEnv), '{}')

    await waitForFlushIdle(dataDir)
    if (readState(dataDir).backoffUntil <= Date.now()) {
      await flushOutboxAsync({ dataDir, gameDirectories: discoveredDirs })
    }
    const stateAfter429 = readState(dataDir)
    assert.ok(stateAfter429.backoffUntil > Date.now(), '429 后应记录未来退避时间')
    assert.equal(shouldSpawnFlush(dataDir, stateAfter429, true, Date.now()), false, '退避窗口内不应立即拉起 flush')
    assert.equal(readdirSync(eventsDir).filter(f => f.endsWith('.json')).length, 1, '429 时事件文件必须保留')

    // 写入超过 7 天接收窗口的过期事件，解除 429 并跳过退避直接测试过期保留
    server.setRateLimit(false)
    const expiredId = createEventId(['expired-test', 1])
    writeFileSync(
      join(eventsDir, `${expiredId}.json`),
      JSON.stringify({ id: expiredId, type: 'tool', at: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
      'utf8'
    )
    const stateReset = readState(dataDir)
    stateReset.backoffUntil = 0
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify(stateReset), 'utf8')
    await runFlushProcess(testEnv)
    await waitForFlushIdle(dataDir)
    const remainingFiles = readdirSync(eventsDir).filter(f => f.endsWith('.json'))
    assert.deepEqual(remainingFiles, [`${expiredId}.json`], '过期事件应保留现场，有效事件应补投清除')
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const syntaxCount = checkSyntax()
  checkManifests()
  await runIntegration()
  console.log(`校验通过：语法校验 ${syntaxCount} 个模块，清单合法，完整档发现、5 类事件映射、离线补投、429 退避与过期保留均已验证。`)
}

main().catch(error => {
  console.error('agy-piggy 检查失败：', error)
  process.exitCode = 1
})
