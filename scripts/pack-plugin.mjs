// @ts-check
/** 按运行时白名单生成自包含的 tgz 与 zip 发布包，并用 agy CLI 校验归档。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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
    const packageDir = join(stageBase, 'agy-piggy')
    mkdirSync(packageDir, { recursive: true })
    for (const item of RUNTIME_ITEMS) {
      cpSync(join(REPO_ROOT, item), join(packageDir, item), { recursive: true })
    }

    const baseName = `${plugin.name}-${plugin.version}`
    const stageTgz = join(stageBase, `${baseName}.tgz`)
    const stageZip = join(stageBase, `${baseName}.zip`)
    archive(['-c', '--format=ustar', '-z', '-f', stageTgz, '-C', stageBase, 'agy-piggy'])
    archive(['-c', '--format=zip', '-f', stageZip, '-C', stageBase, 'agy-piggy'])

    const agyProbe = spawnSync('agy', ['--version'], { encoding: 'utf8', windowsHide: true })
    if (!agyProbe.error || agyProbe.error.code !== 'ENOENT') {
      const validate = spawnSync('agy', ['plugin', 'validate', stageZip, '--strict', '--json'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (validate.status !== 0) {
        throw new Error(`agy plugin validate 校验归档失败：${validate.stdout || validate.stderr}`)
      }
      const report = JSON.parse(validate.stdout)
      assert.deepEqual(report.findings ?? [], [], `归档包存在 validate 发现项：${validate.stdout}`)
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
