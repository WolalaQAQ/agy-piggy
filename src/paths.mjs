// @ts-check
/** 插件数据目录、可选配置与官方游戏 work-endpoint 自动发现路径解析。 */
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_CONFIG_BYTES = 65536
const MAX_DISCOVERY_META_BYTES = 4096

/** @typedef {{platform?:string,env?:NodeJS.ProcessEnv,home?:string}} PlatformOptions */
/** @typedef {{enabled:boolean,directory?:string,gameDirectory?:string}} PluginConfig */

/** @param {unknown} value @returns {string | undefined} */
function normalizeAbsPath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0') || !isAbsolute(trimmed)) return undefined
  return resolve(trimmed)
}

/** @param {string} filePath @param {number} maxBytes @returns {any} */
function readSmallJsonSync(filePath, maxBytes) {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} name @param {PlatformOptions} options */
function configurationDirectory(name, options) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), name)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', name)
  const xdgConfig = normalizeAbsPath(env.XDG_CONFIG_HOME)
  return join(xdgConfig || join(home, '.config'), name)
}

/** @param {string} pluginRoot @returns {PluginConfig} */
export function loadPluginConfig(pluginRoot) {
  const raw = readSmallJsonSync(join(pluginRoot, 'config.json'), MAX_CONFIG_BYTES)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: true }
  const directory = normalizeAbsPath(raw.directory)
  const gameDirectory = normalizeAbsPath(raw.gameDirectory)
  return {
    enabled: raw.enabled !== false,
    ...(directory ? { directory } : {}),
    ...(gameDirectory ? { gameDirectory } : {}),
  }
}

/** @param {PlatformOptions & {directory?:string}} [options] */
export function resolveDataDirectory(options = {}) {
  const env = options.env ?? process.env
  const explicit = normalizeAbsPath(options.directory) || normalizeAbsPath(env.AGY_PIGGY_DATA_DIR)
  if (explicit) return explicit
  const pluginData = normalizeAbsPath(env.PLUGIN_DATA)
  if (pluginData) return pluginData
  return configurationDirectory('agy-piggy-plugin', options)
}

/**
 * 解析并校验 userData 下的独立完整档选择文件（只读）与默认 work-endpoint。
 * @param {string} userDataDir
 * @returns {string[]}
 */
function expandUserData(userDataDir) {
  const resolvedRoot = resolve(userDataDir)
  const result = []
  const selection = readSmallJsonSync(join(resolvedRoot, 'owner-archive-selection.json'), MAX_DISCOVERY_META_BYTES)
  if (selection && typeof selection === 'object' && selection.version === 1 && selection.active && typeof selection.active === 'object') {
    const docPath = normalizeAbsPath(selection.active.ownerDocumentPath)
    if (docPath) {
      const archiveRoot = join(resolvedRoot, 'owner-archives')
      const rel = relative(archiveRoot, docPath)
      const segments = rel.split(sep)
      if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) &&
          !segments.includes('..') && segments.at(-1) === 'owner-document.json') {
        result.push(`${docPath}.work-events`)
      }
    }
  }
  result.push(join(resolvedRoot, 'work-endpoint'))
  return result
}

/**
 * 返回按优先级排序且去重后的游戏工作接口目录候选列表。
 * @param {PlatformOptions & {gameDirectory?:string}} [options]
 * @returns {string[]}
 */
export function resolveGameDirectories(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform

  const explicit = normalizeAbsPath(options.gameDirectory) || normalizeAbsPath(env.AGY_PIGGY_GAME_ENDPOINT)
  if (explicit) return [explicit]

  /** @type {string[]} */
  const candidates = []
  const seen = new Set()
  const pushUnique = dir => {
    const resolved = resolve(dir)
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push(resolved)
    }
  }

  const ownerDocCfgPath = normalizeAbsPath(env.PIGGY_OWNER_DOCUMENT_CONFIG)
  if (ownerDocCfgPath) {
    const cfg = readSmallJsonSync(ownerDocCfgPath, MAX_DISCOVERY_META_BYTES)
    const docPath = normalizeAbsPath(cfg?.ownerDocumentPath)
    if (docPath) pushUnique(`${docPath}.work-events`)
  }

  const piggyUserData = normalizeAbsPath(env.PIGGY_USERDATA)
  if (piggyUserData) {
    for (const dir of expandUserData(piggyUserData)) pushUnique(dir)
    return candidates
  }

  const xdgData = normalizeAbsPath(env.XDG_DATA_HOME)
  const piggyDir = platform === 'linux'
    ? join(xdgData || join(home, '.local', 'share'), 'piggy')
    : configurationDirectory('piggy', options)
  for (const dir of expandUserData(piggyDir)) pushUnique(dir)

  const dshHomes = [normalizeAbsPath(env.DSH_HOME), resolve(join(home, '.dsh'))].filter(Boolean)
  for (const dshHome of dshHomes) {
    const marker = readSmallJsonSync(join(/** @type {string} */ (dshHome), 'dsh-piggy', 'desktop-app.json'), MAX_DISCOVERY_META_BYTES)
    const workDir = normalizeAbsPath(marker?.external?.workEndpointDir)
    if (workDir) pushUnique(workDir)
  }

  for (const legacyName of ['dsh-piggy', 'dsh-piggy-desktop']) {
    for (const dir of expandUserData(configurationDirectory(legacyName, options))) pushUnique(dir)
  }

  return candidates
}
