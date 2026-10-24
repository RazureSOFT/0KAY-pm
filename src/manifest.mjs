import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Package identity and the manifest contract.
//
// A manifest is executable: it names commands that will run with the user's
// privileges, and paths that will be read from a tarball. So it is validated
// hard and early — before anything is downloaded, and again before anything
// runs. Every path that comes out of it goes through within().

export const packages = {
  '@razuresoft/0kay': { repository: 'https://github.com/RazureSOFT/0KAY.git', manifest: 'manifest.json' },
  '@razuresoft/0kay-agent': { repository: 'https://github.com/RazureSOFT/0KAY-agent.git', manifest: 'manifest.json' },
  '@razuresoft/0kay-core': { repository: 'https://github.com/RazureSOFT/0KAY.git', manifest: 'core/manifest.json' },
  '@razuresoft/0kay-life': { repository: 'https://github.com/RazureSOFT/0KAY.git', manifest: 'life/manifest.json' },
  '@razuresoft/0kay-mocr': { repository: 'https://github.com/RazureSOFT/0KAY.git', manifest: 'mocr/manifest.json' },
  '@razuresoft/0kay-mcp': { repository: 'https://github.com/RazureSOFT/0KAY-mcp.git', manifest: 'manifest.json' },
  '@razuresoft/0kay-webui': { repository: 'https://github.com/RazureSOFT/0KAY.git', manifest: 'webui/manifest.json' },
}

// Set by the region detector at startup; OKAY_NPM_REGISTRY still wins.
let registry = process.env.OKAY_NPM_REGISTRY || 'https://registry.npmjs.org'

export function configureRegistry(url) {
  if (url) registry = String(url).replace(/\/+$/, '')
  return registry
}
const NAME_PATTERN = /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/
const PLUGIN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const CONTROL_CHARS = /[\r\n\0]/

export function normalizeRepository(value) {
  const raw = typeof value === 'string' ? value : value && value.url
  if (!raw) return null
  const url = String(raw)
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  return match ? `https://github.com/${match[1]}/${match[2]}.git` : null
}

export async function resolveSpec(name) {
  if (packages[name]) return packages[name]
  if (name.includes('/') && !name.startsWith('@')) {
    return { repository: `https://github.com/${name}.git`, manifest: 'manifest.json' }
  }
  try {
    const response = await fetch(`${registry}/${name}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (response.ok) {
      const repository = normalizeRepository((await response.json()).repository)
      if (repository) return { repository, manifest: 'manifest.json' }
    }
  } catch {
    // Offline, or a name that only exists on GitHub. Fall through.
  }
  const ownerRepo = name.replace(/^@/, '')
  if (/^[^/]+\/[^/]+$/.test(ownerRepo)) return { repository: `https://github.com/${ownerRepo}.git`, manifest: 'manifest.json' }
  return null
}

// The directory name under ~/.0kay/packages. A reinstall keeps the previous one
// so the package does not move out from under a running service.
export function packageFolder(name, repoSpec) {
  if (!repoSpec) return name.startsWith('@razuresoft/') ? name.split('/')[1] : name.replace(/^@/, '').replace(/\//g, '-')
  const trimmed = name
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/^@/, '')
  return trimmed.split('/').pop() || 'package'
}

export function within(root, relative) {
  const value = path.resolve(root, relative)
  if (value !== root && !value.startsWith(root + path.sep)) throw new Error('Manifest path escapes package')
  return value
}

export function archiveUrl(repository, branch = 'main', tag = null) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repository)
  if (!match) throw new Error(`Unsupported repository URL: ${repository}`)
  const ref = tag ? `refs/tags/${tag}` : `refs/heads/${branch}`
  return `https://github.com/${match[1]}/${match[2]}/archive/${ref}.tar.gz`
}

export function selfUpdateTarget({ source = null, version = null, branch = 'main', mirror = false } = {}) {
  if (source) return path.resolve(source)
  const ref = version ? `v${String(version).replace(/^v/, '')}` : branch
  const url = `https://codeload.github.com/RazureSOFT/0KAY-pm/tar.gz/${ref}`
  const prefix = mirror ? (typeof mirror === 'string' ? String(mirror).replace(/\/+$/, '') : 'https://gh-proxy.com') : ''
  return prefix ? `${prefix}/${url}` : url
}

function argvList(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(`Manifest ${label} must be argument arrays`)
  if (value.some((arg) => typeof arg !== 'string' || CONTROL_CHARS.test(arg))) {
    throw new Error(`Manifest ${label} must be argument arrays`)
  }
}

function textList(value, label) {
  const text = (entry) => typeof entry === 'string' && entry.trim() !== '' && !CONTROL_CHARS.test(entry)
  if (!Array.isArray(value) || value.some((entry) => !text(entry))) {
    throw new Error(`Manifest ${label} must be non-empty strings`)
  }
}

function objectList(value, label, required) {
  if (!Array.isArray(value)) throw new Error(`Manifest ${label} must be an array`)
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Manifest ${label} entries must be objects`)
    }
    for (const key of required) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) throw new Error(`Manifest ${label}.${key} is required`)
    }
    for (const key of ['name', 'description', 'prompt', 'event']) {
      if (entry[key] != null && (typeof entry[key] !== 'string' || CONTROL_CHARS.test(entry[key]))) {
        throw new Error(`Manifest ${label}.${key} must be a string`)
      }
    }
  }
}

export function validateManifest(value) {
  if (value.schema !== 1 || typeof value.name !== 'string' || !NAME_PATTERN.test(value.name) || typeof value.version !== 'string') {
    throw new Error('Invalid manifest identity/schema')
  }
  for (const command of [...(value.install || []), ...(value.start ? [value.start] : []), ...(value.ui?.build || [])]) {
    argvList(command, 'commands')
  }
  if (value.patches != null) textList(value.patches, 'patches')

  if (value.ui != null) {
    if (typeof value.ui !== 'object' || value.ui === null || Array.isArray(value.ui)) throw new Error('Manifest ui must be an object')
    if (value.ui.dir != null && (typeof value.ui.dir !== 'string' || CONTROL_CHARS.test(value.ui.dir))) {
      throw new Error('Manifest ui.dir must be a path string')
    }
    if (value.ui.plugin != null && !PLUGIN_PATTERN.test(value.ui.plugin)) throw new Error('Manifest ui.plugin is invalid')
    if (value.ui.dist != null && (typeof value.ui.dist !== 'string' || CONTROL_CHARS.test(value.ui.dist))) {
      throw new Error('Manifest ui.dist must be a path string')
    }
    if (value.ui.build != null && !Array.isArray(value.ui.build)) throw new Error('Manifest ui.build must be argv arrays')
  }

  if (value.permissions != null) {
    if (typeof value.permissions !== 'object' || value.permissions === null || Array.isArray(value.permissions)) {
      throw new Error('Manifest permissions must be an object')
    }
    const { api, egress } = value.permissions
    if (api != null) {
      if (typeof api !== 'object' || api === null || Array.isArray(api)) throw new Error('Manifest permissions.api must be an object')
      if (api.requires != null) textList(api.requires, 'permissions.api.requires')
      if (api.exposes != null) textList(api.exposes, 'permissions.api.exposes')
    }
    if (egress != null) textList(egress, 'permissions.egress')
  }

  if (value.capabilities != null) {
    if (typeof value.capabilities !== 'object' || value.capabilities === null || Array.isArray(value.capabilities)) {
      throw new Error('Manifest capabilities must be an object')
    }
    const { commands, skills, hooks, mcpServers, agents } = value.capabilities
    if (commands != null) objectList(commands, 'capabilities.commands', ['name', 'prompt'])
    if (agents != null) objectList(agents, 'capabilities.agents', ['name', 'prompt'])
    if (hooks != null) {
      if (!Array.isArray(hooks)) throw new Error('Manifest capabilities.hooks must be an array')
      for (const hook of hooks) {
        if (typeof hook !== 'object' || hook === null || Array.isArray(hook) || typeof hook.event !== 'string' || !hook.event.trim()) {
          throw new Error('Manifest capabilities.hooks entries need an event')
        }
        argvList(hook.command, 'capabilities.hooks.command')
      }
    }
    if (mcpServers != null) {
      if (!Array.isArray(mcpServers)) throw new Error('Manifest capabilities.mcpServers must be an array')
      for (const server of mcpServers) {
        if (typeof server !== 'object' || server === null || Array.isArray(server) || typeof server.id !== 'string' || !server.id.trim()) {
          throw new Error('Manifest capabilities.mcpServers entries need an id')
        }
      }
    }
    if (skills != null) textList(skills, 'capabilities.skills')
  }
  return value
}

// Copy a built UI into Core's plugin-ui directory. Staged and renamed because
// Core serves that directory live: a half-copied bundle is a white page.
export async function publishPluginUI(sourceDir, pluginName, dataDir) {
  if (!PLUGIN_PATTERN.test(pluginName)) throw new Error('Invalid plugin-ui name')
  const root = path.resolve(dataDir || process.env.CORE_DATA_DIR || 'data')
  const dest = path.join(root, 'plugin-ui', pluginName)
  const staging = `${dest}.install-${randomUUID()}`
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.cp(sourceDir, staging, { recursive: true })
  await fs.rm(dest, { recursive: true, force: true })
  await fs.rename(staging, dest)
  return dest
}
