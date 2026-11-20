// @ts-check
/** 验证发布标签与插件版本一致，生成双语 Release 说明。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_URL = 'https://github.com/WolalaQAQ/agy-piggy'

/** @param {string} relPath */
function readJSON(relPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'))
}

/** @param {string} relPath @param {string} version */
function changelogSection(relPath, version) {
  const sections = readFileSync(join(REPO_ROOT, relPath), 'utf8').split(/^## /m).slice(1)
  const section = sections.find(text => text.startsWith(`[${version}] - `))
  if (!section) throw new Error(`${relPath} 缺少版本 ${version}`)
  return `## ${section.trim()}`
}

function main() {
  const args = process.argv.slice(2)
  const tag = args.find(arg => !arg.startsWith('--'))
  const outputArg = args.find(arg => arg.startsWith('--output='))
  const outputPath = outputArg ? outputArg.slice('--output='.length) : ''

  const pkg = readJSON('package.json')
  const plugin = readJSON('plugin.json')
  const version = pkg.version
  if (tag !== `v${version}`) throw new Error(`标签须与 package.json 一致：v${version}`)
  if (plugin.version !== version) throw new Error('package.json 与 plugin.json 版本不一致')

  const chinese = changelogSection('CHANGELOG.md', version)
  const english = changelogSection('CHANGELOG.en.md', version)
  const baseName = `${plugin.name}-${version}`
  const channel = version.includes('-') ? 'next' : 'latest'
  const installCmd = `npx ${plugin.name}@${channel}`
  const downloads = ['zip', 'tgz']
    .map(ext => {
      const fileName = `${baseName}.${ext}`
      return `- [${fileName}](${REPOSITORY_URL}/releases/download/${tag}/${fileName})`
    })
    .join('\n')

  const content = [
    '# 中文',
    '',
    chinese,
    '',
    '### 安装',
    '',
    '```sh',
    installCmd,
    '```',
    '',
    '### 离线归档',
    '',
    downloads,
    '',
    `下载 \`.zip\` 解压后执行 \`agy plugin install ./agy-piggy\`；下载 \`.tgz\` 解压后执行 \`node ./package/bin/agy-piggy.mjs\`（或 \`agy plugin install ./package\`）。游戏要求与可选配置见 [README](${REPOSITORY_URL}/blob/${tag}/README.md)。`,
    '',
    '---',
    '',
    '# English',
    '',
    english,
    '',
    '### Install',
    '',
    '```sh',
    installCmd,
    '```',
    '',
    '### Offline archives',
    '',
    downloads,
    '',
    `Extract the \`.zip\` archive and run \`agy plugin install ./agy-piggy\`, or extract the \`.tgz\` archive and run \`node ./package/bin/agy-piggy.mjs\` (or \`agy plugin install ./package\`). See the [README](${REPOSITORY_URL}/blob/${tag}/README.en.md) for game requirements and optional configuration.`,
  ].join('\n')

  if (outputPath) {
    writeFileSync(resolve(outputPath), `${content}\n`, 'utf8')
  } else {
    process.stdout.write(`${content}\n`)
  }
}

try {
  main()
} catch (error) {
  console.error(`生成发布说明失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
