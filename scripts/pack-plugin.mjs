// @ts-check
/** 生成 npm 标准包（.tgz）与纯插件归档（.zip），并用 agy CLI 严格校验。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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

const tar = process.platform === 'win32' ? 'tar.exe' : process.platform === 'darwin' ? 'tar' : 'bsdtar'

/** @param {string[]} args */
function archive(args) {
  const run = spawnSync(tar, args, { stdio: 'inherit' })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`归档失败：${tar}，退出码 ${run.status}`)
}

/** @param {Record<string, any>} rootPkg */
function buildPublicPackageJson(rootPkg) {
  const pub = {
    name: rootPkg.name,
    version: rootPkg.version,
    description: rootPkg.description,
    type: rootPkg.type,
    license: rootPkg.license,
    author: rootPkg.author,
    bin: rootPkg.bin,
    files: [...RUNTIME_ITEMS, 'bin'],
    publishConfig: {
      access: 'public',
      registry: 'https://registry.npmjs.org',
    },
    repository: rootPkg.repository,
    homepage: rootPkg.homepage,
    bugs: rootPkg.bugs,
    keywords: rootPkg.keywords,
    engines: rootPkg.engines,
  }
  return `${JSON.stringify(pub, null, 2)}\n`
}

/** @param {string} target */
function validateWithAgy(target) {
  const validate = spawnSync('agy', ['plugin', 'validate', target, '--strict', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (validate.status !== 0) {
    throw new Error(`agy plugin validate 校验失败（${target}）：${validate.stdout || validate.stderr}`)
  }
  const report = JSON.parse(validate.stdout)
  assert.deepEqual(report.findings ?? [], [], `归档存在 validate 发现项：${validate.stdout}`)
}

function main() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin.json'), 'utf8'))
  assert.equal(pkg.name, 'agy-piggy', 'package.json 名称必须为 agy-piggy')
  assert.equal(plugin.name, 'agy-piggy', 'plugin.json 名称必须为 agy-piggy')
  assert.equal(pkg.version, plugin.version, 'package.json 与 plugin.json 版本不一致')

  const tool = spawnSync(tar, ['--version'], { encoding: 'utf8' })
  if (tool.error || tool.status !== 0 || !tool.stdout.includes('bsdtar')) {
    throw new Error('打包需要 libarchive/bsdtar：Windows 使用系统 tar.exe，macOS 使用系统 tar，Linux 请安装 libarchive-tools 并提供 bsdtar')
  }

  const stageBase = mkdtempSync(join(tmpdir(), 'agy-piggy-pack-'))
  try {
    // 1. npm 发布包暂存目录（stage/package/）
    const npmPkgDir = join(stageBase, 'package')
    mkdirSync(join(npmPkgDir, 'bin'), { recursive: true })
    for (const item of RUNTIME_ITEMS) {
      cpSync(join(REPO_ROOT, item), join(npmPkgDir, item), { recursive: true })
    }
    const binSource = readFileSync(join(REPO_ROOT, 'bin', 'agy-piggy.mjs'), 'utf8').replace(/\r\n/g, '\n')
    const binTarget = join(npmPkgDir, 'bin', 'agy-piggy.mjs')
    writeFileSync(binTarget, binSource, 'utf8')
    chmodSync(binTarget, 0o755)
    writeFileSync(join(npmPkgDir, 'package.json'), buildPublicPackageJson(pkg), 'utf8')

    // 2. 纯插件 ZIP 暂存目录（stage/agy-piggy/）
    const zipPluginDir = join(stageBase, 'agy-piggy')
    mkdirSync(zipPluginDir, { recursive: true })
    for (const item of RUNTIME_ITEMS) {
      cpSync(join(REPO_ROOT, item), join(zipPluginDir, item), { recursive: true })
    }

    const baseName = `${plugin.name}-${plugin.version}`
    const stageTgz = join(stageBase, `${baseName}.tgz`)
    const stageZip = join(stageBase, `${baseName}.zip`)
    archive(['-c', '--format=ustar', '-z', '-f', stageTgz, '-C', stageBase, 'package'])
    archive(['-c', '--format=zip', '-f', stageZip, '-C', stageBase, 'agy-piggy'])

    const agyProbe = spawnSync('agy', ['--version'], { encoding: 'utf8', windowsHide: true })
    if (!agyProbe.error || agyProbe.error.code !== 'ENOENT') {
      validateWithAgy(stageZip)
      validateWithAgy(npmPkgDir)
    }

    const distDir = join(REPO_ROOT, 'dist')
    mkdirSync(distDir, { recursive: true })
    for (const ext of ['tgz', 'zip']) {
      const fileName = `${baseName}.${ext}`
      const targetPath = join(distDir, fileName)
      cpSync(join(stageBase, fileName), targetPath)
      console.log(`已生成 ${targetPath}（${statSync(targetPath).size} 字节）`)
    }
  } finally {
    rmSync(stageBase, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`agy-piggy 打包失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
