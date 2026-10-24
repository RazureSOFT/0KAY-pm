import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { downloadOnce, extractTarGz } from './download.mjs'

// Build toolchains, downloaded on demand.
//
// A source install needs go/node/python and the machine usually has none of
// them, or has a version too old to matter. Rather than fail with "go: command
// not found" we fetch the official tarball into ~/.0kay/toolchains and put it
// first on PATH for that one child process. Checksums are mandatory unless you
// explicitly set OKAY_TOOLCHAIN_INSECURE=1, because a tarball off the internet
// is the whole supply chain.

export const DEFAULT_VERSIONS = {
  go: process.env.OKAY_GO_VERSION || process.env.OKAY_TOOLCHAIN_GO_VERSION || '1.27.0',
  node: process.env.OKAY_NODE_VERSION || process.env.OKAY_TOOLCHAIN_NODE_VERSION || '22.12.0',
  python: process.env.OKAY_PYTHON_VERSION || process.env.OKAY_TOOLCHAIN_PYTHON_VERSION || '3.12.7',
}

// Where the toolchain tarballs come from. Redirected wholesale by region: in
// mainland China go.dev and nodejs.org are slow enough that the mirror is not a
// nicety, and the files are the same files.
let sources = {
  go: 'https://go.dev',
  node: 'https://nodejs.org/dist',
  python: 'https://github.com/astral-sh/python-build-standalone/releases/latest/download',
}

export function configureToolchainSources(next = {}) {
  sources = { ...sources, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value)) }
  return { ...sources }
}

export function toolchainSources() {
  return { ...sources }
}

const EXECUTABLES = {
  go: 'go',
  'go.exe': 'go',
  node: 'node',
  'node.exe': 'node',
  python: 'python',
  'python.exe': 'python',
  python3: 'python',
}

const TRIPLETS = {
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  win32: { x64: 'x86_64-pc-windows-msvc' },
}

export function platformInfo(platform = process.platform, arch = process.arch) {
  const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform] || null
  const nodeOS = { win32: 'win', darwin: 'darwin', linux: 'linux' }[platform] || null
  const goArch = { x64: 'amd64', arm64: 'arm64' }[arch] || null
  const nodeArch = { x64: 'x64', arm64: 'arm64' }[arch] || null
  const triple = TRIPLETS[platform]?.[arch] || null
  if (!goos || !goArch || !nodeArch || !triple) throw new Error(`Unsupported platform: ${platform}/${arch}`)
  return { platform, arch, goos, nodeOS, goArch, nodeArch, triple }
}

export function toolchainFor(executable) {
  return EXECUTABLES[String(executable).toLowerCase()] || null
}

export function isKnownToolchain(executable) {
  return toolchainFor(executable) !== null
}

export function executablePath(tool, dir, platform = process.platform) {
  if (tool === 'python') {
    if (platform === 'win32') {
      const flat = path.join(dir, 'python.exe')
      return existsSync(flat) ? flat : path.join(dir, 'python', 'python.exe')
    }
    for (const name of ['python3', 'python']) {
      const candidate = path.join(dir, 'bin', name)
      if (existsSync(candidate)) return candidate
    }
    return path.join(dir, 'bin', 'python3')
  }
  const file = platform === 'win32' ? `${tool}.exe` : tool
  // The Node zip unpacks flat on Windows and into bin/ everywhere else.
  return tool === 'node' && platform === 'win32' ? path.join(dir, file) : path.join(dir, 'bin', file)
}

export function binDirs(tool, dir, platform = process.platform) {
  if (tool === 'go') return [path.join(dir, 'bin')]
  if (tool === 'node') return platform === 'win32' ? [dir] : [path.join(dir, 'bin')]
  if (tool === 'python') return platform === 'win32' ? [dir, path.join(dir, 'Scripts')] : [path.join(dir, 'bin')]
  return []
}

export function parseShasums(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim())
    if (match) map.set(match[2], match[1])
  }
  return map
}

export function goFilename(version, info) {
  const extension = info.goos === 'windows' ? 'zip' : 'tar.gz'
  return `go${version}.${info.goos}-${info.goArch}.${extension}`
}

export function nodeFilename(version, info) {
  const extension = info.nodeOS === 'win' ? 'zip' : 'tar.gz'
  return `node-v${version}-${info.nodeOS}-${info.nodeArch}.${extension}`
}

function compareVersions(a, b) {
  const left = String(a).replace(/^go/, '').split('.').map(Number)
  const right = String(b).replace(/^go/, '').split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] || 0) - (right[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

// Exact version first, then the newest patch on the same minor line. Asking for
// go1.22.0 when only go1.22.7 exists is a normal thing to do, not an error.
export function selectGoRelease(releases, version) {
  const wanted = `go${version}`
  const exact = (releases || []).find((release) => release.version === wanted)
  if (exact) return exact
  const [major, minor] = String(version).split('.')
  if (major == null || minor == null) return null
  const patches = (releases || []).filter((release) => new RegExp(`^go${major}\\.${minor}\\.\\d+$`).test(release.version))
  if (!patches.length) return null
  return patches.sort((a, b) => compareVersions(a.version, b.version))[patches.length - 1]
}

export function selectPythonAsset(names, version, triple) {
  const target = String(triple).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^cpython-(\\d+\\.\\d+\\.\\d+)\\+.+-${target}-install_only\\.tar\\.gz$`)
  const matches = (names || []).map((name) => pattern.exec(name)).filter(Boolean)
  if (!matches.length) return null
  const exact = matches.find((match) => match[1] === version)
  if (exact) return exact.input
  const [major, minor] = String(version).split('.')
  const sameLine = matches.filter((match) => match[1].startsWith(`${major}.${minor}.`))
  if (!sameLine.length) return null
  sameLine.sort((a, b) => compareVersions(a[1], b[1]))
  return sameLine[sameLine.length - 1].input
}

// go.mod is the authority on which Go a package needs. Walk up until we find it
// — the caller is usually a subdirectory of the module.
export async function requiredGoVersion(cwd) {
  let dir = path.resolve(cwd || '.')
  for (let depth = 0; depth < 25; depth++) {
    try {
      const text = await fs.readFile(path.join(dir, 'go.mod'), 'utf8')
      const toolchain = /^toolchain\s+go(\S+)/m.exec(text)
      const directive = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)
      const value = (toolchain?.[1] || directive?.[1])?.trim()
      if (value) return value.split('.').length < 3 ? `${value}.0` : value
      return null
    } catch (error) {
      if (error.code !== 'ENOENT') return null
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function goAsset(version, info, agent) {
  const releases = JSON.parse((await downloadOnce(`${sources.go}/dl/?mode=json&include=all`, 5, agent)).toString('utf8'))
  const release = selectGoRelease(releases, version)
  const resolved = release ? release.version.replace(/^go/, '') : version
  const filename = goFilename(resolved, info)
  const file = (release?.files || []).find((entry) => entry.filename === filename)
  return {
    filename,
    url: `${sources.go}/dl/${filename}`,
    sha256: file?.sha256 || null,
    archive: info.goos === 'windows' ? 'zip' : 'tar.gz',
  }
}

async function nodeAsset(version, info, agent) {
  const filename = nodeFilename(version, info)
  const base = `${sources.node}/v${version}/`
  const shasums = parseShasums((await downloadOnce(`${base}SHASUMS256.txt`, 5, agent)).toString('utf8'))
  return { filename, url: base + filename, sha256: shasums.get(filename) || null, archive: info.nodeOS === 'win' ? 'zip' : 'tar.gz' }
}

async function pythonAsset(version, info, agent) {
  const base = `${sources.python}/`
  const headers = { 'user-agent': '0kay-pm' }
  const sums = parseShasums((await downloadOnce(`${base}SHA256SUMS`, 5, agent, headers)).toString('utf8'))
  const name = selectPythonAsset([...sums.keys()], version, info.triple)
  if (!name) throw new Error(`No python-build-standalone asset for ${version} ${info.triple}`)
  return { filename: name, url: base + encodeURIComponent(name), sha256: sums.get(name) || null, archive: 'tar.gz' }
}

function runFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  })
}

async function extractZip(buffer, target) {
  const temporary = path.join(os.tmpdir(), `0kay-toolchain-${crypto.randomUUID()}.zip`)
  await fs.writeFile(temporary, buffer)
  try {
    try {
      await runFile('tar', ['-xf', temporary, '-C', target])
    } catch {
      // Old Windows 10 builds ship a tar that cannot read zip; PowerShell can.
      const quoted = (value) => String(value).replace(/'/g, "''")
      await runFile('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${quoted(temporary)}' -DestinationPath '${quoted(target)}' -Force`,
      ])
    }
  } finally {
    await fs.rm(temporary, { force: true })
  }
  await flattenSingleRoot(target)
}

async function flattenSingleRoot(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) return
  const nested = path.join(dir, entries[0].name)
  for (const entry of await fs.readdir(nested)) await fs.rename(path.join(nested, entry), path.join(dir, entry))
  await fs.rm(nested, { recursive: true, force: true })
}

async function downloadAndVerify(asset, log) {
  log(`Downloading ${asset.filename}...`)
  const buffer = await downloadOnce(asset.url, 5, asset.agent, asset.headers)
  if (process.env.OKAY_TOOLCHAIN_INSECURE === '1') return buffer
  if (!asset.sha256) {
    throw new Error(`No checksum published for ${asset.filename}; set OKAY_TOOLCHAIN_INSECURE=1 to override`)
  }
  const digest = crypto.createHash('sha256').update(buffer).digest('hex')
  if (digest !== asset.sha256.toLowerCase()) throw new Error(`Checksum mismatch for ${asset.filename}`)
  return buffer
}

const inFlight = new Map()

export async function ensureToolchain(executable, options = {}) {
  const tool = toolchainFor(executable)
  if (!tool) return null

  const info = platformInfo(options.platform, options.arch)
  const home = options.home || path.join(os.homedir(), '.0kay')
  let version = options.version || null
  if (!version && tool === 'go') version = await requiredGoVersion(options.cwd || '.')
  if (!version) version = DEFAULT_VERSIONS[tool]

  const dir = path.join(home, 'toolchains', tool, version)
  const existing = executablePath(tool, dir, info.platform)
  if (existsSync(existing)) return existing
  if (options.allowDownload === false) return null

  // Two installs racing for the same toolchain would both unpack into dir.
  const key = `${tool}@${version}@${info.platform}/${info.arch}`
  if (inFlight.has(key)) return inFlight.get(key)

  const log = options.log || console.log
  const task = (async () => {
    const agent = options.agent || null
    const asset = tool === 'go' ? await goAsset(version, info, agent)
      : tool === 'node' ? await nodeAsset(version, info, agent)
        : await pythonAsset(version, info, agent)
    asset.agent = agent
    const buffer = await downloadAndVerify(asset, log)
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    log(`Installing ${tool} ${version} into ${dir}...`)
    if (asset.archive === 'zip') await extractZip(buffer, dir)
    else extractTarGz(buffer, dir, { links: true })
    const installed = executablePath(tool, dir, info.platform)
    if (!existsSync(installed)) throw new Error(`Provisioned ${tool} ${version} is missing ${path.basename(existing)}`)
    return installed
  })()

  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

export async function toolchainBinDirs(home, platform = process.platform) {
  const root = path.join(home || path.join(os.homedir(), '.0kay'), 'toolchains')
  const dirs = []
  for (const tool of ['go', 'node', 'python']) {
    let versions = []
    try {
      versions = await fs.readdir(path.join(root, tool))
    } catch {
      continue
    }
    for (const version of versions) {
      for (const bin of binDirs(tool, path.join(root, tool, version), platform)) {
        if (existsSync(bin)) dirs.push(bin)
      }
    }
  }
  return dirs
}
