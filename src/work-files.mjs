// @ts-check
/** 插件私有队列目录与官方发现文件的异步权限操作与指纹缓存。 */
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_CACHE_ENTRIES = 64

const DIRECTORY_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
  '$sid = $identity.User',
  '$ownerSid = $identity.Owner',
  '$sidType = [System.Security.Principal.SecurityIdentifier]',
  '$sections = [System.Security.AccessControl.AccessControlSections]',
  '$directory = [System.IO.DirectoryInfo]::new($env:PIGGY_WORK_PATH)',
  '$directory.Refresh()',
  'if (-not $directory.Exists -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "work directory must be a real directory" }',
  '$currentOwner = $directory.GetAccessControl($sections::Owner).GetOwner($sidType)',
  'if (-not $currentOwner.Equals($sid) -and -not $currentOwner.Equals($ownerSid)) { throw "work directory owner mismatch" }',
  'if (-not $currentOwner.Equals($sid)) {',
  '  $acl = $directory.GetAccessControl($sections::Access -bor $sections::Owner)',
  '  $acl.SetOwner($sid)',
  '} else {',
  '  $acl = $directory.GetAccessControl($sections::Access)',
  '}',
  '$acl.SetAccessRuleProtection($true, $false)',
  'foreach ($oldRule in $acl.GetAccessRules($true, $false, $sidType)) { $acl.RemoveAccessRuleSpecific($oldRule) }',
  '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"))',
  '$directory.SetAccessControl($acl)',
  '$check = $directory.GetAccessControl($sections::Access)',
  '$rules = @($check.GetAccessRules($true, $true, $sidType))',
  'if (-not $check.AreAccessRulesProtected -or $rules.Count -ne 1) { throw "work directory DACL verification failed" }',
  '$rule = $rules[0]',
  'if (-not $rule.IdentityReference.Equals($sid) -or $rule.IsInherited -or [int]$rule.AccessControlType -ne 0 -or [int]$rule.FileSystemRights -ne 0x1f01ff -or [int]$rule.InheritanceFlags -ne 3 -or [int]$rule.PropagationFlags -ne 0) { throw "work directory DACL verification failed" }',
].join('; ')

const FILE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
  '$sid = $identity.User',
  '$ownerSid = $identity.Owner',
  '$sidType = [System.Security.Principal.SecurityIdentifier]',
  '$sections = [System.Security.AccessControl.AccessControlSections]',
  '$file = [System.IO.FileInfo]::new($env:PIGGY_WORK_PATH)',
  '$file.Refresh()',
  'if (-not $file.Exists -or ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "work file must be a real file" }',
  '$currentOwner = $file.GetAccessControl($sections::Owner).GetOwner($sidType)',
  'if (-not $currentOwner.Equals($sid) -and -not $currentOwner.Equals($ownerSid)) { throw "work file owner mismatch" }',
  '$rules = @($file.GetAccessControl($sections::Access).GetAccessRules($true, $true, $sidType))',
  'if ($rules.Count -eq 0) { throw "work file DACL invalid" }',
  'foreach ($rule in $rules) { if (-not $rule.IdentityReference.Equals($sid) -or [int]$rule.AccessControlType -ne 0) { throw "work file is not private" } }',
].join('; ')

/** @param {string} targetPath */
function cacheKey(targetPath) {
  const resolved = resolve(targetPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** @param {import('node:fs').Stats} stat */
function statFingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
}

/** @param {Record<string, string> | undefined} cache @param {string} key @param {string} fp */
function rememberFingerprint(cache, key, fp) {
  if (!cache || typeof cache !== 'object') return
  delete cache[key]
  cache[key] = fp
  const keys = Object.keys(cache)
  if (keys.length > MAX_CACHE_ENTRIES) {
    for (const oldKey of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) {
      delete cache[oldKey]
    }
  }
}

/** @param {string} script @param {string} targetPath */
function runPowerShellAsync(script, targetPath) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, PIGGY_WORK_PATH: targetPath }, windowsHide: true },
      error => error ? reject(error) : resolvePromise(undefined)
    )
  })
}

/** @param {import('node:fs').Stats} stat */
function verifyPosixOwner(stat) {
  if (process.platform !== 'win32' && stat.uid !== process.getuid()) {
    throw new Error('work path owner mismatch')
  }
}

/**
 * 异步准备并加固当前用户的私有队列目录。
 * @param {string} directory
 * @param {Record<string, string>} [verifiedCache]
 * @returns {Promise<void>}
 */
export async function secureWorkDirectoryAsync(directory, verifiedCache) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('work directory must be a real directory')
  verifyPosixOwner(stat)
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700)
    return
  }
  const key = cacheKey(directory)
  const fp = statFingerprint(stat)
  if (verifiedCache && verifiedCache[key] === fp) return
  await runPowerShellAsync(DIRECTORY_SCRIPT, resolve(directory))
  const updated = await lstat(directory)
  rememberFingerprint(verifiedCache, key, statFingerprint(updated))
}

/**
 * 异步验证发现文件自身具备私有权限，不依赖父目录权限。
 * @param {string} filePath
 * @param {Record<string, string>} [verifiedCache]
 * @returns {Promise<void>}
 */
export async function verifyPrivateWorkFileAsync(filePath, verifiedCache) {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('work file must be a real file')
  verifyPosixOwner(stat)
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new Error('work file is not private')
    return
  }
  const key = cacheKey(filePath)
  const fp = statFingerprint(stat)
  if (verifiedCache && verifiedCache[key] === fp) return
  await runPowerShellAsync(FILE_SCRIPT, resolve(filePath))
  rememberFingerprint(verifiedCache, key, fp)
}
