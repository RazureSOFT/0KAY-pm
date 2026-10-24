#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { randomInt } from 'node:crypto'
import { discover, pinnedRequest, expandTargets, localSubnets } from '../src/discovery.mjs'
import {
  installPackage,
  uninstallPackage,
  run,
  validateManifest,
  within,
  configureToolchains,
  resolveCommand,
  selfUpdateTarget,
  restrictToUser,
  verifySourceChecksum,
} from '../src/installer.mjs'
import { parseTarget as parseInstallTarget, readLocalName } from '../src/target.mjs'
import { proxyAgentFor, latestReleaseTag, downloadOnce } from '../src/download.mjs'
import { toolchainBinDirs } from '../src/toolchain.mjs'
import { installServices, stopServices, servicesStatus } from '../src/service.mjs'
import { parsePort, portEnv, bindEnv } from '../src/env.mjs'
import { detectRegion, mirrorsFor, normalizeRegion, probeFastest } from '../src/region.mjs'
import { configureToolchainSources } from '../src/toolchain.mjs'
import { configureRegistry } from '../src/manifest.mjs'

// 0kay-pm: install 0KAY packages on this machine and wire them to a Core.
//
// The interesting part is not installing — it is the two things around it:
// pairing with a Core on the LAN without trusting whatever answers the broadcast,
// and writing a runtime-env.json the services can start from on boot without a
// human in the loop.

const HOME = process.env.OKAY_PM_HOME || path.join(os.homedir(), '.0kay')
const STATE_FILE = path.join(HOME, 'state.json')
const CORE_PACKAGES = new Set(['@razuresoft/0kay', '@razuresoft/0kay-core'])

const argv = process.argv.slice(2)
// `0kay-pm install@foo` is a thing people type; accept it.
if (argv[0]?.startsWith('install@')) argv.splice(0, 1, 'install', argv[0].slice(7))

const flag = (name) => {
  const index = argv.indexOf(name)
  return index < 0 ? null : argv[index + 1]
}
const has = (name) => argv.includes(name)

await fs.mkdir(HOME, { recursive: true, mode: 0o700 })

let state = { cores: {}, installed: {}, pairings: {} }
try {
  state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

async function saveState() {
  await fs.writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
  await fs.rename(`${STATE_FILE}.tmp`, STATE_FILE)
}

async function ask(question) {
  if (!process.stdin.isTTY) throw new Error('Interactive terminal required for pairing')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// Versions, scoped names and local trees all arrive as one string; src/target.mjs
// owns the rules and this is the thin call.
function parseTarget(raw) {
  return parseInstallTarget(raw, { versionFlag: flag('--version') })
}

// Short names, because `0kay-pm install 0kay` is what people actually type.
// The full package names still work; these are just the front door.
const ALIASES = {
  '0kay': '@razuresoft/0kay',
  core: '@razuresoft/0kay-core',
  webui: '@razuresoft/0kay-webui',
  life: '@razuresoft/0kay-life',
  mocr: '@razuresoft/0kay-mocr',
  agent: '@razuresoft/0kay-agent',
  mcp: '@razuresoft/0kay-mcp',
}

function canonicalName(name) {
  if (!name) return name
  if (ALIASES[name]) return ALIASES[name]
  if (ALIASES[name.replace(/^0kay-/, '')]) return ALIASES[name.replace(/^0kay-/, '')]
  return name
}

const coreDataRoot = () => path.join(
  state.installed['@razuresoft/0kay']?.repositoryRoot || path.join(HOME, 'packages', '0kay'),
  'core',
  'data',
)

// --proxy alone means "go through the gh-proxy mirror"; --proxy host:port (or a
// URL) means "tunnel through that proxy". Two different things, one flag,
// because that is how the docs read.
const proxyValue = flag('--proxy')
const proxyUrl = proxyValue && !proxyValue.startsWith('--') && /[:/]/.test(proxyValue) ? proxyValue : null
const proxyMirror = has('--proxy') && !proxyUrl

// Where this machine is decides the default source for everything we download.
// A VPN makes the timezone a liar, so --mirror / --no-mirror / OKAY_REGION
// override the guess, and `0kay-pm mirror --probe` settles it with a race.
const mirrorValue = flag('--mirror')
const explicitMirrorUrl = has('--mirror') && mirrorValue && !mirrorValue.startsWith('--') && /[:/]/.test(mirrorValue)
  ? mirrorValue.replace(/\/+$/, '')
  : null
const detected = detectRegion()
const forcedRegion = normalizeRegion(flag('--region'))
const region = has('--no-mirror')
  ? 'global'
  : (has('--mirror') || proxyMirror ? 'cn' : (forcedRegion || detected.region))
const mirrors = mirrorsFor(region)
const githubMirror = explicitMirrorUrl
  || (has('--no-mirror') ? '' : mirrors.github)
  || (proxyMirror ? 'https://gh-proxy.com' : '')

configureToolchainSources({ go: mirrors.go, node: mirrors.node, python: mirrors.python })
configureRegistry(mirrors.npm)
const allowToolchainDownload = !has('--no-toolchain-download') && process.env.OKAY_TOOLCHAIN_DOWNLOAD !== '0'

let toolchainAgent = null
try {
  toolchainAgent = proxyAgentFor({ proxyUrl })
} catch {
  toolchainAgent = null
}
const buildProxy = proxyUrl ? (String(proxyUrl).includes('://') ? String(proxyUrl) : `http://${proxyUrl}`) : null
configureToolchains({ home: HOME, allowDownload: allowToolchainDownload, agent: toolchainAgent, proxy: buildProxy })

async function askPort(label, fallback) {
  for (;;) {
    const raw = await ask(`${label} [${fallback}]: `)
    if (!raw) return fallback
    try {
      return parsePort(label, raw)
    } catch (error) {
      console.log(error.message)
    }
  }
}

// Defaults are the point: a local install should be one command and zero
// questions. --interactive brings the prompts back for people who want to pick.
async function portChoices(name, { interactive = false } = {}) {
  const choices = {}
  const wantsCore = CORE_PACKAGES.has(name)
  const wantsWebui = name === '@razuresoft/0kay' || name === '@razuresoft/0kay-webui'

  if (interactive && process.stdin.isTTY) {
    if (wantsCore && flag('--core-port') == null) choices.http = await askPort('Core HTTP port', 8080)
    if (wantsCore && flag('--core-grpc-port') == null) choices.grpc = await askPort('Core gRPC port', 50051)
    if (wantsWebui && flag('--webui-port') == null) choices.webui = await askPort('WebUI port', 3000)
  }
  choices.http ??= parsePort('--core-port', flag('--core-port'))
  choices.grpc ??= parsePort('--core-grpc-port', flag('--core-grpc-port'))
  choices.webui ??= parsePort('--webui-port', flag('--webui-port'))

  if (wantsCore || wantsWebui) {
    const bindFlag = flag('--bind-host')
    if (bindFlag != null) choices.bindHost = bindFlag
    else if (has('--expose')) choices.bindHost = '0.0.0.0'
    else if (has('--no-expose')) choices.bindHost = null
    else if (interactive && process.stdin.isTTY) {
      const answer = (await ask('Expose Core and WebUI on 0.0.0.0 (reachable from other devices, no authentication)? [y/N] ')).toLowerCase()
      choices.bindHost = answer === 'y' || answer === 'yes' ? '0.0.0.0' : null
    } else {
      choices.bindHost = null
    }
  }
  return choices
}

async function scan(extraTargets = [], timeout, maxHosts, broadcast = true) {
  // Remembered hosts are retried explicitly: broadcast is blocked on a lot of
  // corporate and guest networks, and re-pairing every time is hostile.
  const remembered = broadcast ? Object.values(state.cores || {}).map((core) => core.host).filter(Boolean) : []
  const targets = [...new Set([...extraTargets, ...remembered])]
  const cores = await discover(timeout, expandTargets(targets, maxHosts), { broadcast })
  for (const core of cores) {
    const known = state.cores[core.id]
    if (known && known.fingerprint !== core.fingerprint) core.identity_changed = true
    state.cores[core.id] = core
  }
  await saveState()
  return cores
}

function discoverTargets(rest) {
  const out = []
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]
    if (value === '--lan') {
      out.push(...localSubnets())
      continue
    }
    if (value === '--host' || value === '--subnet') {
      const next = rest[index + 1]
      if (next && !next.startsWith('--')) {
        out.push(next)
        index++
      }
      continue
    }
    if (value === '--timeout' || value === '--max-hosts') {
      index++
      continue
    }
    if (value.startsWith('--')) continue
    out.push(value)
  }
  for (const value of String(process.env.OKAY_DISCOVER_HOSTS || '').split(',')) {
    if (value.trim()) out.push(value.trim())
  }
  return out
}

async function pair(cores, { confirm = true } = {}) {
  if (!cores.length) {
    console.log('No LAN Core discovered. Start Core with CORE_LAN_ENABLED=1; UDP 50050 and TLS 8443/5443 must be reachable.')
    return null
  }
  cores.forEach((core, index) => {
    console.log(`${index + 1}. ${core.name} ${core.host} [${core.id}] fingerprint ${core.fingerprint}${core.identity_changed ? ' CHANGED' : ''}`)
  })

  const selected = flag('--core')
    ? cores.find((core) => core.id === flag('--core'))
    : cores[Number(await ask('Choose Core number (Enter skips pairing): ')) - 1]
  if (!selected) return null
  if (selected.identity_changed) throw new Error('Core identity changed; investigate before pairing')
  if (state.pairings[selected.id]) return { ...selected, ...state.pairings[selected.id] }

  if (confirm && (await ask(`Pair with ${selected.name} (${selected.host})? [y/N] `)).toLowerCase() !== 'y') return null

  const request = await pinnedRequest(selected, '/api/pairing/request', { name: os.hostname() })
  console.log(`Pairing code: ${request.code}. On the Core computer open Settings → Devices and approve this same code. Waiting up to five minutes.`)

  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const result = await pinnedRequest(selected, '/api/pairing/status', { id: request.id, secret: request.secret })
    if (!result.approved) continue
    const certificate = path.join(HOME, `core-${selected.id}.crt`)
    await fs.writeFile(certificate, result.certificate, { mode: 0o600 })
    state.pairings[selected.id] = { token: result.token, certificate, server_name: result.server_name }
    await saveState()
    return { ...selected, ...state.pairings[selected.id] }
  }
  throw new Error('Pairing timed out')
}

function randomPin() {
  return String(randomInt(100000, 1000000))
}

async function configure(record, core, choices) {
  const env = {}
  if (core) {
    const interfaces = Object.values(os.networkInterfaces()).flat()
      .filter((value) => value && value.family === 'IPv4' && !value.internal)
    const subnet = (address) => address.split('.').slice(0, 3).join('.')
    const address = flag('--advertise') || interfaces.find((value) => subnet(value.address) === subnet(core.host))?.address
    if (!address) throw new Error('Cannot determine callback address; pass --advertise <LAN-IP>')

    const agentBindHost = has('--expose-lan') ? '0.0.0.0' : '127.0.0.1'
    Object.assign(env, {
      CORE_ADDRESS: `${core.host}:${core.grpc_port}`,
      CORE_HTTP_ADDR: `https://${core.host}:${core.http_port}`,
      CORE_PAIR_TOKEN: core.token,
      CORE_TLS_CA: core.certificate,
      CORE_TLS_NAME: core.server_name,
      NODE_EXTRA_CA_CERTS: core.certificate,
      AGENT_ADDRESS: `${address}:50054`,
      AGENT_BIND_HOST: agentBindHost,
      MOCR_ADDRESS: `${core.host}:${core.grpc_port}`,
    })
    if (has('--expose-lan')) {
      console.log(`WARNING: agent gRPC bound to 0.0.0.0 on ${address}:50054; the channel is plaintext and protected only by its Bearer token.`)
    }
  }

  Object.assign(env, portEnv(choices, Boolean(core)))
  Object.assign(env, bindEnv(choices.bindHost, record.name))
  if (choices.bindHost) console.log(`Exposing Core and WebUI on ${choices.bindHost}; they will be reachable from the network without authentication.`)
  if (CORE_PACKAGES.has(record.name)) {
    env.CORE_LAN_ENABLED = '1'
    env.CORE_PIN = randomPin()
  }

  const envFile = path.join(record.repositoryRoot, 'runtime-env.json')
  await fs.writeFile(envFile, JSON.stringify(env, null, 2), { mode: 0o600 })
  await restrictToUser(envFile)
  return env.CORE_PIN
}

async function packageUnits(record, env, { resolve = false } = {}) {
  const specs = []
  const shortName = (name) => name.split('/')[1].replace(/^0kay-/, '')

  if ((record.modules || []).length) {
    for (const relative of record.modules) {
      try {
        const manifestPath = within(record.repositoryRoot, relative)
        const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
        if (manifest.start) {
          specs.push({ name: `0kay-${shortName(manifest.name)}`, command: manifest.start, cwd: path.dirname(manifestPath) })
        }
      } catch {
        // A module without a start command (library or UI only) has no unit.
      }
    }
  } else if (record.start) {
    specs.push({ name: `0kay-${shortName(record.name)}`, command: record.start, cwd: record.cwd })
  }

  const binDirs = await toolchainBinDirs(HOME)
  const units = []
  for (const spec of specs) {
    units.push({
      name: spec.name,
      command: resolve ? await resolveCommand(spec.command, spec.cwd, HOME) : spec.command,
      cwd: spec.cwd,
      env: env || {},
      binDirs,
    })
  }
  return units
}

async function readRuntimeEnv(record) {
  return JSON.parse(await fs.readFile(path.join(record.repositoryRoot, 'runtime-env.json'), 'utf8').catch(() => '{}'))
}

async function startServices(record) {
  const env = await readRuntimeEnv(record)
  const units = await packageUnits(record, env, { resolve: true })
  if (!units.length) {
    console.log('Library/UI package; no service to start.')
    return
  }
  const { backend } = await installServices({ home: HOME, units })
  console.log(`Started ${units.map((unit) => unit.name).join(', ')} via ${backend}. They keep running after this session ends and start on boot.`)
  console.log(`Stop with: 0kay-pm stop ${record.name}`)
}

async function startForeground(record) {
  const env = await readRuntimeEnv(record)
  const units = await packageUnits(record, env)
  if (!units.length) {
    console.log('Library/UI package; no standalone process.')
    return
  }
  console.log(`Starting ${record.name} in this terminal; press Ctrl+C to stop.`)
  await Promise.all(units.map((unit) => run(unit.command, unit.cwd, env)))
}

async function stopPackage(name) {
  const record = state.installed[name]
  if (!record) throw new Error(`${name} is not installed`)
  const units = await packageUnits(record, null)
  await stopServices({ home: HOME, names: units.map((unit) => unit.name) })
  console.log(`Stopped ${units.map((unit) => unit.name).join(', ') || '(no services)'}.`)
}

async function printStatus(name) {
  const record = state.installed[name]
  if (!record) throw new Error(`${name} is not installed`)
  const units = await packageUnits(record, null)
  if (!units.length) {
    // A library/UI package has nothing to report, but silence reads as "the
    // command is broken". Say so.
    console.log(`${record.name} ${record.version}: no services (library/UI package)`)
    return
  }
  for (const row of await servicesStatus({ home: HOME, names: units.map((unit) => unit.name) })) {
    console.log(`${row.name}\t${row.state}`)
  }
}

async function cliVersion() {
  try {
    return JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version || '?'
  } catch {
    return '?'
  }
}

async function selfUpdate() {
  const source = flag('--source')
  const raw = argv[1] && !argv[1].startsWith('-') ? argv[1] : null
  const pinned = (raw ? parseTarget(raw).version : null) || flag('--version')
  const beta = has('--beta') || has('--main')
  const current = await cliVersion()

  let target
  let label
  let version = null
  if (source) {
    label = path.resolve(source)
    target = selfUpdateTarget({ source })
  } else {
    version = pinned ? String(pinned).replace(/^v/, '') : null
    if (!version && !beta) {
      const tag = await latestReleaseTag('RazureSOFT', '0KAY-pm', { mirror: githubMirror, proxyUrl })
      if (tag) version = tag.replace(/^v/, '')
    }
    label = version ? `v${version}` : 'main'
    target = selfUpdateTarget({ version, mirror: githubMirror })
  }

  console.log(`Updating 0kay-pm ${current} → ${label} (npm install -g).`)
  if (target.startsWith('http')) {
    const buffer = await downloadOnce(target, 5, proxyAgentFor({ proxyUrl }))
    const warning = await verifySourceChecksum(
      'https://github.com/RazureSOFT/0KAY-pm.git',
      version ? `v${version}` : null,
      buffer,
      { mirror: githubMirror, proxyUrl },
    )
    if (warning) console.log(`Warning: ${warning}`)
    const tarball = path.join(os.tmpdir(), `0kay-pm-${label.replace(/[^\w.-]+/g, '')}.tar.gz`)
    await fs.writeFile(tarball, buffer, { mode: 0o600 })
    try {
      await run(['npm', 'install', '-g', tarball], process.cwd())
    } finally {
      await fs.rm(tarball, { force: true }).catch(() => {})
    }
  } else {
    await run(['npm', 'install', '-g', target], process.cwd())
  }
  console.log(`0kay-pm updated to ${label}. Re-run your command to use the new version.`)
}

const HELP = [
  'install:',
  '  0kay-pm install                install everything locally (same as: install 0kay)',
  '  0kay-pm install <name>         short names: 0kay core webui life mocr agent mcp',
  '  0kay-pm install <name>@1.2.3   pin a release tag',
  '',
  'run it:',
  '  0kay-pm start <name> [--foreground]    stop <name>    status <name>    uninstall <name>',
  '',
  'no questions asked:',
  '  Ports default to 8080 / 50051 / 3000, Core binds to loopback, services start on',
  '  boot. Override only what you need:',
  '    --interactive            ask for ports and LAN exposure (the old behaviour)',
  '    --core-port <n>  --core-grpc-port <n>  --webui-port <n>',
  '    --expose | --bind-host <addr> | --no-expose',
  '    --pair | --core <id>     install against a Core on another machine (LAN pairing)',
  '    --expose-lan             bind the agent gRPC to 0.0.0.0 (plaintext, Bearer token only)',
  '',
  'network:',
  '  Sources are picked from where this machine is: a Chinese timezone/locale gets',
  '  the CN mirrors (gh-proxy, npmmirror, golang.google.cn), anything else goes',
  '  direct. See `0kay-pm mirror`, override with:',
  '    --mirror | --no-mirror   force mirrors on/off',
  '    --region cn|global       override the guess (or OKAY_REGION=...)',
  '    --mirror <url>           use that GitHub proxy instead of the default',
  '  --proxy                  download through the gh-proxy.com mirror',
  '  --proxy host:port        tunnel through that HTTP proxy (HTTPS_PROXY works too)',
  '  --source <local-tree>    install a local checkout instead of a tarball',
  '  --no-toolchain-download  never fetch go/node/python; use what is on PATH',
  '',
  'other:',
  '  0kay-pm discover [ip ...] [--host <ip>] [--subnet <cidr>] [--lan] [--timeout <ms>]',
  '  0kay-pm cores',
  '  0kay-pm mirror [--probe]   show (or race) the download sources',
  '  0kay-pm self-update [<version>] [--beta | --main] [--source <local-tree>]',
  '',
  'Services keep running after the session ends and start on boot; only `stop`',
  'shuts them down. --foreground runs in this terminal instead.',
].join('\n')

// Pick a Core to pair with, or explain why there isn't one.
//
// The old flow asked "Choose Core number:" every single time, which is a wall in
// front of the common case. Now: --core picks explicitly, one result is used,
// several are listed for the user to re-run with --core <id>.
async function chooseCore(cores) {
  const wanted = flag('--core')
  if (wanted) {
    const match = cores.find((core) => core.id === wanted)
    if (!match) throw new Error(`No Core with id ${wanted} on the LAN (run: 0kay-pm discover)`)
    return pair(match, { confirm: false })
  }
  if (!cores.length) {
    console.log('No Core on the LAN; installing standalone.')
    return null
  }
  if (cores.length === 1) {
    const [only] = cores
    console.log(`Found Core ${only.name} at ${only.host} [${only.id}].`)
    // Pairing needs a human on the other side to approve a code, so a headless
    // run would just hang. Say what to do instead.
    if (!process.stdin.isTTY) {
      console.log('Not a terminal, so not pairing. Re-run with --pair when someone can approve the code.')
      return null
    }
    return pair(only)
  }
  console.log(`${cores.length} Cores on the LAN; installing standalone. Pick one with --core <id>:`)
  for (const core of cores) console.log(`  ${core.id}  ${core.name}  ${core.host}`)
  return null
}

// --help anywhere means "tell me, do not do it". Without this guard
// `0kay-pm self-update --help` cheerfully reinstalls the tool.
if (argv.length === 0 || argv[0] === 'help' || has('--help') || has('-h')) {
  console.log(HELP)
  process.exit(0)
}

const commands = {
  async discover() {
    const explicit = discoverTargets(argv.slice(1))
    const cores = await scan(
      explicit,
      Number(flag('--timeout')) || undefined,
      Number(flag('--max-hosts')) || undefined,
      explicit.length === 0,
    )
    console.log(JSON.stringify(cores, null, 2))
    if (explicit.length && !cores.length) {
      console.error('No Core answered at the requested target(s). Ensure the target runs Core with CORE_LAN_ENABLED=1 and UDP 50050 is reachable.')
    }
  },

  async cores() {
    console.log(JSON.stringify(state.cores, null, 2))
  },

  async install() {
    // `0kay-pm install` with nothing else installs the whole thing locally.
    const target = parseTarget(argv[1] && !argv[1].startsWith('-') ? argv[1] : '0kay')
    // A local tree names itself: reading the manifest here means the record, the
    // folder and the dependency walk all use the same identity.
    if (target.source) {
      target.name = readLocalName(target.source)
      console.log(`Installing from ${target.source}`)
    } else {
      target.name = canonicalName(target.name)
    }

    // Always look for a Core on the LAN: finding one is how this machine joins an
    // existing install, and silently ignoring it would be worse than the two
    // seconds the broadcast costs. What we no longer do is make you pick a number
    // from a list — one Core is used, several are listed, none means standalone.
    const cores = has('--no-pair') ? [] : await scan()
    const core = await chooseCore(cores)
    const choices = await portChoices(target.name, { interactive: has('--interactive') })

    console.log(`Installing ${target.name}${target.version ? `@${target.version}` : ''}. Package manifests run build/install commands from the selected repository.`)
    const record = await installPackage(target.name, {
      home: HOME,
      source: target.source || flag('--source'),
      mirror: githubMirror,
      proxyUrl,
      tag: target.version ? `v${target.version}` : null,
      coreData: coreDataRoot(),
    }, state)
    await configure(record, core, choices)
    await saveState()
    console.log(`Installed ${record.name}@${record.version}.`)

    if (has('--foreground')) await startForeground(record)
    else await startServices(record)

    if (CORE_PACKAGES.has(record.name)) {
      const pin = JSON.parse(await fs.readFile(path.join(record.repositoryRoot, 'runtime-env.json'), 'utf8')).CORE_PIN
      if (pin) console.log(`\n  Access PIN: ${pin}\n  Use this PIN to sign in to Core; change it in the setup wizard.\n`)
    }
  },

  async update() {
    const target = parseTarget(argv[1])
    if (!target.name) throw new Error('Usage: 0kay-pm update <package>[@version] [--proxy] [--source <local-tree>]')
    if (target.name === '@razuresoft/0kay-pm' || target.name === '0kay-pm') {
      await selfUpdate()
      return
    }
    target.name = canonicalName(target.name)
    if (!state.installed[target.name]) throw new Error(`${target.name} is not installed`)
    console.log(`Updating ${target.name}${target.version ? `@${target.version}` : ' to the latest main branch'}.`)
    const record = await installPackage(target.name, {
      home: HOME,
      source: flag('--source'),
      mirror: githubMirror,
      proxyUrl,
      reinstall: true,
      tag: target.version ? `v${target.version}` : null,
      coreData: coreDataRoot(),
    }, state)
    await saveState()
    console.log(`Updated ${record.name}@${record.version}. Start: 0kay-pm start ${record.name}`)
  },

  async start() {
    const record = state.installed[canonicalName(argv[1])]
    if (!record) throw new Error('Package not installed')
    if (has('--foreground')) await startForeground(record)
    else await startServices(record)
  },

  async stop() {
    const name = canonicalName(argv[1])
    if (!name) throw new Error('Usage: 0kay-pm stop <package>')
    await stopPackage(name)
  },

  async uninstall() {
    const name = canonicalName(argv[1])
    if (!name) throw new Error('Usage: 0kay-pm uninstall <package>')
    if (!state.installed[name]) throw new Error(`${name} is not installed`)
    await stopPackage(name).catch(() => {})
    const result = await uninstallPackage(name, { home: HOME, coreData: coreDataRoot() }, state)
    await saveState()
    const removed = result.removed.length ? `; removed ${result.removed.join(', ')}` : ''
    const kept = result.removedTree ? '' : '; kept source tree in place'
    console.log(`Uninstalled ${result.name}${removed}${kept}.`)
  },

  async mirror() {
    const probe = has('--probe')
    const why = has('--no-mirror') ? 'forced off by --no-mirror'
      : has('--mirror') || proxyMirror ? 'forced on by --mirror'
        : forcedRegion ? 'forced by --region'
          : detected.reason
    console.log(`region: ${region} (${why})`)
    console.log(`github: ${githubMirror || '(direct)'}`)
    console.log(`npm:    ${mirrors.npm}`)
    console.log(`go:     ${mirrors.go}`)
    console.log(`node:   ${mirrors.node}`)
    console.log(`python: ${mirrors.python}`)
    if (!probe) {
      console.log('\nOverride with --mirror | --no-mirror | --region cn|global, or OKAY_REGION / OKAY_GITHUB_PROXY.')
      return
    }
    // The only honest test: ask both hosts and keep whichever answers first.
    console.log('\nprobing (HEAD, 4s each)...')
    const fastest = await probeFastest({
      direct: 'https://github.com',
      mirror: githubMirror || 'https://gh-proxy.com',
    })
    if (!fastest) {
      console.log('neither answered; leaving the guess alone')
      return
    }
    console.log(`${fastest.name} answered first in ${fastest.ms}ms`)
    if (fastest.name === 'direct' && region === 'cn') {
      console.log('direct is reachable — if this machine is on a VPN, use --no-mirror (or OKAY_REGION=global).')
    }
    if (fastest.name === 'mirror' && region === 'global') {
      console.log('the mirror answered first — use --mirror (or OKAY_REGION=cn) to switch.')
    }
  },

  async status() {
    const name = canonicalName(argv[1])
    if (!name) throw new Error('Usage: 0kay-pm status <package>')
    await printStatus(name)
  },

  async 'self-update'() {
    await selfUpdate()
  },
}
commands.selfupdate = commands['self-update']
commands.upgrade = commands['self-update']

try {
  const handler = commands[argv[0]]
  if (handler) await handler()
  else console.log(HELP)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
