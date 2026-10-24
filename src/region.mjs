// Where in the world is this machine, and which mirrors does that imply?
//
// Downloading from github.com inside mainland China is a coin flip, so the
// default there is a mirror. Everywhere else the mirror is pure latency, so the
// default is direct. The decision is made from things we can read locally —
// timezone and locale — with an optional latency probe to settle the argument
// when the machine is on a VPN and the timezone is a lie.
//
// Precedence, highest first:
//   OKAY_REGION=cn|global          (explicit, wins over everything)
//   OKAY_GITHUB_PROXY / OKAY_NPM_REGISTRY (per-mirror overrides, still honoured)
//   --mirror / --no-mirror          (CLI, applied by the caller)
//   latency probe                   (optional, when the caller asks)
//   timezone, then locale
//   global                          (default)

const CN_TIMEZONES = new Set([
  'Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin',
  'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei',
])

const CN_LOCALES = /^(zh[-_](cn|hans|sg)|wuu|yue)/i

const MIRRORS = {
  cn: {
    github: 'https://gh-proxy.com',
    npm: 'https://registry.npmmirror.com',
    go: 'https://golang.google.cn',
    node: 'https://npmmirror.com/mirrors/node',
    python: 'https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/latest/download',
  },
  global: {
    github: '',
    npm: 'https://registry.npmjs.org',
    go: 'https://go.dev',
    node: 'https://nodejs.org/dist',
    python: 'https://github.com/astral-sh/python-build-standalone/releases/latest/download',
  },
}

export const REGIONS = ['cn', 'global']

export function normalizeRegion(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return null
  if (['cn', 'china', 'zh', 'mainland', 'prc'].includes(text)) return 'cn'
  if (['global', 'intl', 'international', 'world', 'row'].includes(text)) return 'global'
  return null
}

// Local-only detection: no request leaves the machine, so this can run on every
// command without turning `0kay-pm status` into a network call.
export function detectRegion({ env = process.env, timezone, locale } = {}) {
  const explicit = normalizeRegion(env.OKAY_REGION || env.OKAY_MIRROR_REGION)
  if (explicit) return { region: explicit, reason: 'env' }

  let zone = timezone
  if (!zone) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch {
      zone = ''
    }
  }
  if (zone && CN_TIMEZONES.has(zone)) return { region: 'cn', reason: `timezone ${zone}` }

  const tag = locale || env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  if (tag && CN_LOCALES.test(tag)) return { region: 'cn', reason: `locale ${tag}` }

  return { region: 'global', reason: 'default' }
}

// Per-mirror env overrides beat the region defaults: someone who set
// OKAY_NPM_REGISTRY meant it, and a region guess must not undo it.
export function mirrorsFor(region, env = process.env) {
  const table = MIRRORS[region === 'cn' ? 'cn' : 'global']
  const github = (env.OKAY_GITHUB_PROXY || '').trim().replace(/\/+$/, '')
  return {
    region,
    github: github || table.github,
    npm: (env.OKAY_NPM_REGISTRY || '').trim().replace(/\/+$/, '') || table.npm,
    go: (env.OKAY_GO_MIRROR || '').trim().replace(/\/+$/, '') || table.go,
    node: (env.OKAY_NODE_MIRROR || '').trim().replace(/\/+$/, '') || table.node,
    python: (env.OKAY_PYTHON_MIRROR || '').trim().replace(/\/+$/, '') || table.python,
  }
}

// Latency probe: the only way to tell a VPN from a timezone. Races the direct
// host against the mirror and keeps whichever answers first, because a mirror
// that is slower than the thing it mirrors is just an extra hop.
export async function probeFastest(probe, { timeoutMs = 4000 } = {}) {
  const candidates = Object.entries(probe)
  const settled = await Promise.all(candidates.map(async ([name, url]) => {
    const started = Date.now()
    try {
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
      return { name, ms: Date.now() - started }
    } catch {
      return { name, ms: Number.POSITIVE_INFINITY }
    }
  }))
  const reachable = settled.filter((entry) => Number.isFinite(entry.ms)).sort((a, b) => a.ms - b.ms)
  return reachable.length ? reachable[0] : null
}
