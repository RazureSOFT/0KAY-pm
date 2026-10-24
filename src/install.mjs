import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { ensureToolchain, isKnownToolchain, toolchainBinDirs } from './toolchain.mjs'
import { downloadArchive } from './source.mjs'
import { packages, packageFolder, resolveSpec, validateManifest, within, publishPluginUI } from './manifest.mjs'

// Installing a package is: stage a pristine copy, run its commands, then swap it
// into place without losing data or the environment the user already answered
// for. Nothing here writes to the live directory until the swap.

const EXECUTABLE_FALLBACKS = { python: ['python3'], python3: ['python'] }
const PRESERVED_DIRS = ['data', 'core/data', 'life/data', 'agent/data', 'mocr/data']
const SKIPPED_SOURCE_ENTRIES = new Set(['.git', 'node_modules', '__pycache__', 'dist'])

let toolchainConfig = { home: null, allowDownload: true, agent: null, log: null, proxy: null }
let cachedBinDirs = null

export function configureToolchains(options = {}) {
  toolchainConfig = { ...toolchainConfig, ...options }
  cachedBinDirs = null
}

export async function restrictToUser(file, log = console.log) {
  if (process.platform !== 'win32') return
  try {
    await promisify(execFile)(
      'icacls',
      [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME || process.env.USER}:F`],
      { windowsHide: true },
    )
  } catch (error) {
    log(`Warning: could not restrict ${path.basename(file)}: ${error.message}`)
  }
}

function findExecutable(name, cwd, extraDirs = []) {
  if (name.includes('/') || name.includes('\\')) {
    const candidate = path.resolve(cwd || '.', name)
    return existsSync(candidate) ? candidate : null
  }
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  const directories = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs]
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

async function toolchainPathDirs() {
  if (!toolchainConfig.home) return []
  if (!cachedBinDirs) cachedBinDirs = await toolchainBinDirs(toolchainConfig.home)
  return cachedBinDirs
}

// npm/npx are shell scripts on Windows, and spawning them through cmd.exe means
// every argument has to survive cmd's quoting. Resolve the JS entry instead and
// run it with node — one less shell in the middle.
function npmEntryPoint(executable) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${executable}-cli.js`)
  return existsSync(cli) ? cli : null
}

export async function run(command, cwd, env = {}) {
  let [executable, ...args] = command
  let shell = process.platform === 'win32' && ['npm', 'npx'].includes(executable)

  if (shell) {
    const cli = npmEntryPoint(executable)
    if (cli) {
      args = [cli, ...args]
      executable = process.execPath
      shell = false
    }
  }
  if (shell && args.some((arg) => /[&|<>^]/.test(arg))) throw new Error('Unsupported shell operator in npm arguments')

  if (!shell) {
    let found = findExecutable(executable, cwd)
    if (!found && isKnownToolchain(executable)) {
      found = await ensureToolchain(executable, {
        home: toolchainConfig.home,
        cwd,
        allowDownload: toolchainConfig.allowDownload,
        agent: toolchainConfig.agent,
        log: toolchainConfig.log || console.log,
      })
    }
    if (!found) {
      for (const fallback of EXECUTABLE_FALLBACKS[executable] || []) {
        if (findExecutable(fallback, cwd)) {
          executable = fallback
          found = true
          break
        }
      }
    }
    if (!found) throw new Error(`Required command not found: ${executable}. Install it and add it to PATH, then retry.`)
    if (path.isAbsolute(found) && found !== executable) executable = found
  }

  const extraDirs = await toolchainPathDirs()
  const pathValue = [
    ...extraDirs,
    ...String(env.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
  ].join(path.delimiter)

  const proxyEnv = {}
  if (toolchainConfig.proxy) {
    proxyEnv.HTTPS_PROXY = toolchainConfig.proxy
    proxyEnv.HTTP_PROXY = toolchainConfig.proxy
    proxyEnv.ALL_PROXY = toolchainConfig.proxy
    if (process.env.NO_PROXY) proxyEnv.NO_PROXY = process.env.NO_PROXY
  }

  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...proxyEnv, ...env, PATH: pathValue, GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'auto' },
    stdio: 'inherit',
    shell,
  })
  return await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}`))))
  })
}

export async function resolveCommand(command, cwd, home) {
  let [executable, ...args] = command
  if (executable.includes('/') || executable.includes('\\')) {
    executable = path.resolve(cwd || '.', executable)
  } else {
    const extra = home ? await toolchainBinDirs(home) : []
    let resolved = findExecutable(executable, cwd, extra)
    if (!resolved) {
      for (const fallback of EXECUTABLE_FALLBACKS[executable] || []) {
        const candidate = findExecutable(fallback, cwd, extra)
        if (candidate) {
          resolved = candidate
          break
        }
      }
    }
    if (resolved) executable = resolved
  }
  return [executable, ...args]
}

async function publishManifestUI(manifest, manifestDir, options) {
  const uiRoot = within(manifestDir, manifest.ui.dir || '.')
  for (const command of manifest.ui.build || []) await run(command, uiRoot)
  const dist = path.resolve(uiRoot, manifest.ui.dist || 'dist')
  const built = await fs.stat(dist).then(() => true, () => false)
  if (!built) throw new Error(`Plugin UI dist missing: ${dist}`)
  const pluginName = manifest.ui.plugin || manifest.name.split('/')[1]
  await publishPluginUI(dist, pluginName, options.coreData)
}

async function installManifestPatches(manifest, staging, options) {
  if (!manifest.patches || !manifest.patches.length) return
  const root = path.resolve(options.coreData || process.env.CORE_DATA_DIR || 'data')
  const uiDir = path.join(root, 'ui')
  await fs.mkdir(uiDir, { recursive: true })
  for (const relative of manifest.patches) {
    const source = within(staging, relative)
    const present = await fs.stat(source).then(() => true, () => false)
    if (!present) throw new Error(`Manifest patch missing: ${relative}`)
    await fs.copyFile(source, path.join(uiDir, path.basename(relative)))
  }
}

async function stageFromLocalTree(sourceRoot, staging) {
  const root = path.resolve(sourceRoot)
  await fs.cp(root, staging, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(root, source)
      if (!relative) return true
      const base = path.basename(source)
      if (SKIPPED_SOURCE_ENTRIES.has(base)) return false
      // A top-level data/ belongs to the running install, not to the package.
      if (base === 'data' && !relative.includes(path.sep)) return false
      return !source.endsWith('.log') && !source.endsWith('.exe')
    },
  })
}

// The agent package ships with its platform (mcp) tree folded in: agent/ holds
// the code, mcp/ the servers it hosts, proto/ the shared definitions. Doing it
// here keeps the published agent repository flat.
async function arrangeAgentLayout(staging, state) {
  const mcp = state.installed['@razuresoft/0kay-mcp']
  if (!mcp) throw new Error('MCP dependency missing')

  await fs.cp(mcp.repositoryRoot, `${staging}/platform`, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules', 'data'].includes(path.basename(source)),
  })
  await fs.mkdir(path.join(staging, 'agent'), { recursive: true })
  for (const entry of await fs.readdir(staging)) {
    if (entry === 'platform' || entry === 'agent') continue
    await fs.rename(path.join(staging, entry), path.join(staging, 'agent', entry))
  }

  const platform = path.join(staging, 'platform')
  await fs.mkdir(path.join(staging, 'mcp'), { recursive: true })
  for (const entry of await fs.readdir(platform)) {
    if (entry === 'proto') continue
    await fs.rename(path.join(platform, entry), path.join(staging, 'mcp', entry))
  }
  await fs.rename(path.join(platform, 'proto'), path.join(staging, 'proto'))
  await fs.rm(platform, { recursive: true, force: true })

  await run(['npm', 'ci'], path.join(staging, 'mcp'))
  await run(['npm', 'run', 'build'], path.join(staging, 'mcp'))
}

async function preserveData(destination, staging) {
  if (!await fs.stat(destination).then(() => true, () => false)) return
  for (const relative of PRESERVED_DIRS) {
    const source = path.join(destination, relative)
    if (await fs.stat(source).then(() => true, () => false)) {
      await fs.cp(source, path.join(staging, relative), { recursive: true, force: false, errorOnExist: false })
    }
  }
}

// The user answered the port/exposure questions once. Reinstalling must not ask
// again, and must not silently reset them to defaults.
async function readPreviousRuntimeEnv(destination, state, name) {
  const roots = [
    destination,
    state?.installed?.[name] ? state.installed[name].repositoryRoot : null,
  ].filter(Boolean)
  for (const root of roots) {
    const value = await fs.readFile(path.join(root, 'runtime-env.json'), 'utf8').catch(() => null)
    if (value != null) return value
  }
  return null
}

async function swapIntoPlace(destination, staging, previousEnv) {
  if (!await fs.stat(destination).then(() => true, () => false)) {
    await fs.rename(staging, destination)
    return
  }
  // One backup is insurance for the rename below; a dozen of them is just a slow
  // disk leak. Keep the newest, drop the rest.
  const parent = path.dirname(destination)
  const prefix = `${path.basename(destination)}.old-`
  for (const entry of await fs.readdir(parent).catch(() => [])) {
    if (entry.startsWith(prefix)) await fs.rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => {})
  }

  const backup = `${destination}.old-${randomUUID()}`
  await fs.rename(destination, backup)
  try {
    if (previousEnv != null) {
      const envFile = path.join(staging, 'runtime-env.json')
      await fs.writeFile(envFile, previousEnv, { mode: 0o600 })
      await restrictToUser(envFile)
    }
    await fs.rename(staging, destination)
  } catch (error) {
    // Put the old tree back: a failed upgrade must not leave the package gone.
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
    await fs.rename(backup, destination)
    throw error
  }
}

export async function installPackage(name, options, state, stack = []) {
  if (stack.includes(name)) throw new Error(`Dependency cycle: ${[...stack, name].join(' -> ')}`)

  const repoSpec = /^(https?:\/\/|git@)/.test(name) || (name.includes('/') && !name.startsWith('@'))
  if (!repoSpec && state.installed[name] && !options.reinstall) return state.installed[name]

  const previous = state?.installed?.[name] || null
  // A local tree *is* the package: its manifest sits at the root, whatever the
  // published layout calls it (the agent ships as agent/manifest.json upstream).
  const spec = options.source
    ? { repository: null, manifest: 'manifest.json' }
    : options.reinstall && previous?.repository
      ? { repository: previous.repository, manifest: 'manifest.json' }
      : await resolveSpec(name)
  if (!spec) throw new Error(`Unknown package ${name}`)

  const folder = previous?.repositoryRoot ? path.basename(previous.repositoryRoot) : packageFolder(name, repoSpec)
  const destination = path.join(options.home, 'packages', folder)
  await fs.mkdir(path.dirname(destination), { recursive: true })

  const staging = `${destination}.install-${randomUUID()}`
  await fs.mkdir(staging, { recursive: true })

  try {
    if (options.source) await stageFromLocalTree(options.source, staging)
    else await downloadArchive(spec.repository, staging, options)

    const manifestPath = within(staging, spec.manifest)
    const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
    const effectiveName = repoSpec ? manifest.name : name
    if (manifest.name !== effectiveName) throw new Error('Package identity does not match requested package')

    // A manifest may vendor sibling repositories (modules that live in another
    // repo). Only URLs this tool already knows about are honoured.
    for (const repository of manifest.repositories || []) {
      const target = within(staging, repository.path)
      const present = await fs.stat(path.join(target, 'manifest.json')).then(() => true, () => false)
      if (present) continue
      const known = packages[repository.package]
      if (!known || known.repository !== repository.url) throw new Error('Unrecognized module repository')
      await downloadArchive(repository.url, target, { ...options, tag: null })
    }

    for (const dependency of manifest.dependencies || []) {
      // A local install of the meta-package finds its sibling on disk instead of
      // going back to the network for it.
      const siblingSource = options.source && dependency === '@razuresoft/0kay-mcp'
        ? path.resolve(options.source, '..')
        : null
      await installPackage(dependency, { ...options, source: siblingSource }, state, [...stack, name])
    }

    for (const child of manifest.modules || []) {
      const childPath = within(staging, child)
      const module = validateManifest(JSON.parse(await fs.readFile(childPath, 'utf8')))
      for (const command of module.install || []) await run(command, path.dirname(childPath))
      if (module.ui) await publishManifestUI(module, path.dirname(childPath), options)
    }

    if (effectiveName === '@razuresoft/0kay-agent') await arrangeAgentLayout(staging, state)

    const cwd = effectiveName === '@razuresoft/0kay-agent'
      ? path.join(staging, 'agent')
      : path.dirname(manifestPath)
    for (const command of manifest.install || []) await run(command, cwd)
    if (manifest.ui) await publishManifestUI(manifest, path.dirname(manifestPath), options)
    await installManifestPatches(manifest, staging, options)

    await preserveData(destination, staging)
    const previousEnv = await readPreviousRuntimeEnv(destination, state, effectiveName)
    await swapIntoPlace(destination, staging, previousEnv)

    const record = {
      name: effectiveName,
      version: manifest.version,
      repository: spec.repository || manifest.repository || null,
      repositoryRoot: destination,
      cwd: path.join(destination, path.relative(staging, cwd)),
      start: manifest.start || null,
      modules: manifest.modules || [],
      permissions: manifest.permissions || null,
      installed_at: new Date().toISOString(),
    }

    if (effectiveName === '@razuresoft/0kay-life') await run(['python', '-m', 'pip', 'install', '-e', '.'], record.cwd)
    if (effectiveName === '@razuresoft/0kay' && (manifest.modules || []).includes('life/manifest.json')) {
      await run(['python', '-m', 'pip', 'install', '-e', '.'], path.join(destination, 'life'))
    }

    state.installed[effectiveName] = record
    return record
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
}

export async function uninstallPackage(name, options, state) {
  const record = state.installed[name]
  if (!record) throw new Error(`${name} is not installed`)

  const dataRoot = path.resolve(options.coreData || process.env.CORE_DATA_DIR || 'data')
  const removed = []

  try {
    const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(record.repositoryRoot, 'manifest.json'), 'utf8')))
    if (manifest.ui) {
      const plugin = manifest.ui.plugin || manifest.name.split('/')[1]
      await fs.rm(path.join(dataRoot, 'plugin-ui', plugin), { recursive: true, force: true })
      removed.push(`plugin-ui/${plugin}`)
    }
    for (const relative of manifest.patches || []) {
      const file = path.basename(relative)
      await fs.rm(path.join(dataRoot, 'ui', file), { force: true })
      removed.push(`ui/${file}`)
    }
  } catch {
    // The manifest is gone or unreadable; still remove the tree.
  }

  const packagesRoot = path.join(options.home, 'packages')
  const root = path.resolve(record.repositoryRoot)
  // Only delete what this tool created. A --source install points at the user's
  // own checkout; deleting that would be a fucking crime.
  const removedTree = root.startsWith(packagesRoot + path.sep)
  if (removedTree) await fs.rm(root, { recursive: true, force: true })

  delete state.installed[name]
  return { name, removed, removedTree }
}
