import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { downloadOnce, proxyAgentFor, latestReleaseTag, extractTarGz } from './download.mjs'

// The fast path: install the release bundle the packaging workflow publishes
// instead of downloading sources and building them with Go/Node/Python.
// Source builds stay available behind `--build`.

const OWNER = 'RazureSOFT'
const REPO = '0KAY'
const PACKAGE = '@razuresoft/0kay'
const PRESERVED = ['data', 'models', 'runtime-env.json']

export function bundlePlatform(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform]
  const cpu = { x64: 'x64', arm64: 'arm64' }[arch]
  if (!os || !cpu) throw new Error(`No prebuilt bundle for ${platform}/${arch}; use --build`)
  return { os, arch: cpu }
}

export function bundleAssetName(version, platform = process.platform, arch = process.arch) {
  const { os, arch: cpu } = bundlePlatform(platform, arch)
  const clean = String(version || '').replace(/^v/, '')
  if (!clean) throw new Error('A version is required to name a release bundle')
  return `0kay-${os}-${cpu}-v${clean}.tar.gz`
}

export function bundleAssetUrl(version, { mirror = '', baseUrl = '', platform = process.platform, arch = process.arch } = {}) {
  const name = bundleAssetName(version, platform, arch)
  const clean = String(version).replace(/^v/, '')
  // baseUrl is an explicit override (a self-hosted mirror, or a test server);
  // it receives the asset name appended and is not rewritten through a proxy.
  if (baseUrl) return `${String(baseUrl).replace(/\/+$/, '')}/${name}`
  const base = `https://github.com/${OWNER}/${REPO}/releases/download/v${clean}`
  const prefix = typeof mirror === 'string' ? mirror.replace(/\/+$/, '') : ''
  return prefix ? `${prefix}/${base}/${name}` : `${base}/${name}`
}

export function checksumFor(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function parseChecksum(text) {
  const match = String(text || '').trim().match(/^([a-f0-9]{64})\b/i)
  return match ? match[1].toLowerCase() : null
}

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function launcherName() {
  return process.platform === 'win32' ? path.join('bin', '0kay.exe') : path.join('bin', '0kay')
}

export async function resolveBundleVersion({ version = null, mirror = '', proxyUrl = null } = {}) {
  if (version) return String(version).replace(/^v/, '')
  const tag = await latestReleaseTag(OWNER, REPO, { mirror, proxyUrl })
  if (!tag) throw new Error('No published 0KAY release was found; install without --bundle or pass --build')
  return String(tag).replace(/^v/, '')
}

/**
 * Download, verify and swap in the release bundle.
 *
 * The previous `data/`, `models/` and `runtime-env.json` are carried over so an
 * update does not lose the companion's memory or the configured ports.
 */
export async function installBundle(options, state) {
  const { home, runtimeEnv = null } = options
  const version = await resolveBundleVersion(options)
  const url = bundleAssetUrl(version, {
    mirror: options.mirror,
    baseUrl: options.baseUrl || process.env.OKAY_PM_BUNDLE_URL || '',
    platform: options.platform,
    arch: options.arch,
  })
  const agent = proxyAgentFor({ proxyUrl: options.proxyUrl })

  const target = bundlePlatform(options.platform, options.arch)
  console.log(`Downloading 0KAY ${version} (${target.os}/${target.arch}).`)
  const archive = await downloadOnce(url, 5, agent)
  let checksum = null
  try {
    checksum = parseChecksum((await downloadOnce(`${url}.sha256`, 5, agent)).toString('utf8'))
  } catch {
    checksum = null
  }
  if (checksum) {
    const actual = checksumFor(archive)
    if (actual !== checksum) throw new Error(`Checksum mismatch for ${path.basename(url)} (expected ${checksum}, got ${actual})`)
    console.log('Checksum verified.')
  } else {
    console.warn('No .sha256 was published for this asset; continuing without a checksum.')
  }

  const destination = path.join(home, 'packages', '0kay')
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const staging = `${destination}.install-${randomUUID()}`
  await fs.mkdir(staging, { recursive: true })

  try {
    // extractTarGz refuses symlinks; packaging/build.py dereferences them for
    // exactly this reason.
    extractTarGz(archive, staging, {})
    const entries = (await fs.readdir(staging)).filter((entry) => !entry.startsWith('.'))
    const root = entries.length === 1 ? path.join(staging, entries[0]) : staging
    if (!await exists(path.join(root, 'bin'))) throw new Error('The release bundle does not contain a bin/ directory')

    if (await exists(destination)) {
      for (const relative of PRESERVED) {
        const source = path.join(destination, relative)
        if (!await exists(source)) continue
        const target = path.join(root, relative)
        await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false })
      }
    }

    const envFile = path.join(root, 'runtime-env.json')
    const previous = await readJSON(envFile)
    if (runtimeEnv || previous) {
      await fs.writeFile(envFile, JSON.stringify({ ...(previous || {}), ...(runtimeEnv || {}) }, null, 2), { mode: 0o600 })
    }

    const backup = `${destination}.old-${randomUUID()}`
    if (await exists(destination)) await fs.rename(destination, backup)
    try {
      await fs.rename(root, destination)
    } catch (error) {
      // Put the previous install back: a failed update must not leave 0KAY gone.
      if (await exists(backup)) await fs.rename(backup, destination).catch(() => {})
      throw error
    }
    if (root !== staging) await fs.rm(staging, { recursive: true, force: true })
    if (await exists(backup)) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})

    const manifest = await readJSON(path.join(destination, 'manifest.json'))
    const record = {
      name: PACKAGE,
      version: manifest?.version || version,
      repository: `https://github.com/${OWNER}/${REPO}.git`,
      repositoryRoot: destination,
      cwd: destination,
      start: [launcherName(), 'run'],
      modules: [],
      bundle: true,
      permissions: null,
      installed_at: new Date().toISOString(),
    }
    state.installed[PACKAGE] = record
    return record
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
