#!/usr/bin/env node
// @ts-check
/** 安装或卸载 agy-piggy 到 Antigravity 全局插件目录；优先暂存纯净插件目录后调用原生 agy plugin install。 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANAGED_MARKER = '.agy-piggy-managed'
const RUNTIME_ITEMS = [
  'plugin.json',
  'hooks.json',
  'LICENSE',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'CHANGELOG.en.md',
  'assets',
  'src',
]

/** @returns {boolean} */
function hasAgyCli() {
  const probe = spawnSync('agy', ['plugin', 'list', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return !probe.error && probe.status === 0
}

/** @param {string} target */
function removeSymlinkOrJunction(target) {
  try {
    rmSync(target, { recursive: false, force: true })
  } catch {
    rmdirSync(target)
  }
}

/** @param {string} target @param {boolean} [allowUnmanaged] */
function removeExistingManagedTarget(target, allowUnmanaged = false) {
  let stat
  try {
    stat = lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink()) {
    removeSymlinkOrJunction(target)
    return true
  }
  if (stat.isDirectory() && existsSync(join(target, MANAGED_MARKER))) {
    rmSync(target, { recursive: true, force: true })
    return true
  }
  if (allowUnmanaged) return false
  throw new Error(`不覆盖非托管插件目录：${target}`)
}

/** @param {string} target */
function copyRuntimeBundle(target) {
  mkdirSync(target, { recursive: true })
  for (const item of RUNTIME_ITEMS) {
    const src = join(PACKAGE_ROOT, item)
    if (!existsSync(src)) continue
    cpSync(src, join(target, item), { recursive: true })
  }
}

function installViaNativeCli() {
  const stageBase = mkdtempSync(join(tmpdir(), 'agy-piggy-stage-'))
  try {
    const stagePluginDir = join(stageBase, 'agy-piggy')
    copyRuntimeBundle(stagePluginDir)
    const res = spawnSync('agy', ['plugin', 'install', stagePluginDir], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return res.status === 0
  } finally {
    rmSync(stageBase, { recursive: true, force: true })
  }
}

/** @param {{target?: string, copy?: boolean, uninstall?: boolean}} [options] */
export function installAgy(options = {}) {
  const defaultTarget = join(homedir(), '.gemini', 'config', 'plugins', 'agy-piggy')
  const target = resolve(options.target || defaultTarget)
  const useNativeCli = !options.target && hasAgyCli()

  if (options.uninstall) {
    let removed = removeExistingManagedTarget(target, useNativeCli)
    if (useNativeCli) {
      const res = spawnSync('agy', ['plugin', 'uninstall', 'agy-piggy'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (res.status === 0) removed = true
    }
    return { mode: 'uninstall', target, removed }
  }

  if (useNativeCli && !options.copy) {
    removeExistingManagedTarget(target, true)
    if (installViaNativeCli()) {
      return { mode: 'agy-cli', target }
    }
  }

  removeExistingManagedTarget(target)
  mkdirSync(dirname(target), { recursive: true })
  copyRuntimeBundle(target)
  writeFileSync(join(target, MANAGED_MARKER), 'agy-piggy-managed-v1\n', 'utf8')
  return { mode: 'copy', target }
}

function printHelp() {
  console.log([
    '用法：npx agy-piggy@latest [install|uninstall] [选项]',
    '',
    '选项：',
    '  --uninstall        卸载插件入口（保留 PLUGIN_DATA 事件队列）',
    '  --copy             强制使用托管复制模式安装，不调用 agy plugin install',
    '  --target=<绝对路径> 指定自定义安装目录（自动使用托管复制模式）',
    '  -h, --help         显示帮助信息',
  ].join('\n'))
}

function main() {
  const args = process.argv.slice(2)
  let copy = false
  let uninstall = false
  let target
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printHelp()
      return
    }
    if (arg === 'install') {
      continue
    }
    if (arg === 'uninstall' || arg === '--uninstall') {
      uninstall = true
    } else if (arg === '--copy') {
      copy = true
    } else if (arg.startsWith('--target=')) {
      const value = arg.slice('--target='.length).trim()
      if (!value || !isAbsolute(value)) throw new Error(`--target 必须为绝对路径：${value}`)
      target = value
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  const result = installAgy({ target, copy, uninstall })
  if (result.mode === 'uninstall') {
    console.log(result.removed ? `已卸载插件入口（队列保留）：${result.target}` : `未发现已安装入口：${result.target}`)
  } else if (result.mode === 'agy-cli') {
    console.log(`已通过 agy plugin install 安装：agy-piggy（${result.target}）`)
  } else {
    console.log(`已安装插件入口（${result.mode}）：${result.target}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    console.error(`agy-piggy 安装失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
