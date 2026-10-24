import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRegion, mirrorsFor, normalizeRegion, probeFastest } from '../src/region.mjs'

// Region detection decides where every download comes from, so it has to be
// predictable: an explicit setting beats a guess, a guess beats nothing, and a
// mirror never appears where it does not help.

test('an explicit OKAY_REGION wins over the timezone', () => {
  const result = detectRegion({ env: { OKAY_REGION: 'global' }, timezone: 'Asia/Shanghai', locale: 'zh_CN' })
  assert.equal(result.region, 'global')
  assert.equal(result.reason, 'env')
})

test('a Chinese timezone means China', () => {
  for (const timezone of ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei']) {
    assert.equal(detectRegion({ env: {}, timezone }).region, 'cn', timezone)
  }
})

test('a Chinese locale is enough when the timezone is not one we know', () => {
  assert.equal(detectRegion({ env: {}, timezone: 'UTC', locale: 'zh_CN.UTF-8' }).region, 'cn')
  assert.equal(detectRegion({ env: {}, timezone: 'UTC', locale: 'zh-Hans-CN' }).region, 'cn')
})

test('anything else stays direct', () => {
  for (const timezone of ['America/New_York', 'Europe/Berlin', 'UTC']) {
    const result = detectRegion({ env: {}, timezone, locale: 'en_US.UTF-8' })
    assert.equal(result.region, 'global', timezone)
  }
})

test('normalizeRegion accepts the spellings people actually type', () => {
  assert.equal(normalizeRegion('CN'), 'cn')
  assert.equal(normalizeRegion('china'), 'cn')
  assert.equal(normalizeRegion(' global '), 'global')
  assert.equal(normalizeRegion('mars'), null)
  assert.equal(normalizeRegion(''), null)
})

test('mirrors follow the region and use the right host shapes', () => {
  const cn = mirrorsFor('cn', {})
  assert.equal(cn.github, 'https://gh-proxy.com')
  assert.equal(cn.npm, 'https://registry.npmmirror.com')
  assert.equal(cn.go, 'https://golang.google.cn')
  assert.equal(cn.node, 'https://npmmirror.com/mirrors/node')

  const global = mirrorsFor('global', {})
  assert.equal(global.github, '')
  assert.equal(global.npm, 'https://registry.npmjs.org')
  assert.equal(global.go, 'https://go.dev')
  assert.equal(global.node, 'https://nodejs.org/dist')
})

test('per-mirror env overrides beat the region default', () => {
  const mirrors = mirrorsFor('cn', {
    OKAY_NPM_REGISTRY: 'https://registry.example.test/',
    OKAY_GITHUB_PROXY: 'https://mirror.example.test/',
  })
  assert.equal(mirrors.npm, 'https://registry.example.test')
  assert.equal(mirrors.github, 'https://mirror.example.test')
})

test('probeFastest keeps whichever host answers first', async () => {
  const original = globalThis.fetch
  const delays = { 'https://direct.test': 60, 'https://mirror.test': 5 }
  globalThis.fetch = (url) => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), delays[url] ?? 999))
  try {
    const fastest = await probeFastest({ direct: 'https://direct.test', mirror: 'https://mirror.test' }, { timeoutMs: 500 })
    assert.equal(fastest.name, 'mirror')
    assert.ok(fastest.ms >= 0)
  } finally {
    globalThis.fetch = original
  }
})

test('probeFastest gives up when nothing answers', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('offline'))
  try {
    assert.equal(await probeFastest({ direct: 'https://direct.test' }, { timeoutMs: 50 }), null)
  } finally {
    globalThis.fetch = original
  }
})
