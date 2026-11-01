import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bundleAssetName,
  bundleAssetUrl,
  bundlePlatform,
  checksumFor,
  parseChecksum,
} from '../src/bundle.mjs'

test('bundle names follow the release asset contract', () => {
  assert.equal(bundleAssetName('0.1.4', 'win32', 'x64'), '0kay-windows-x64-v0.1.4.tar.gz')
  assert.equal(bundleAssetName('v0.1.4', 'darwin', 'arm64'), '0kay-macos-arm64-v0.1.4.tar.gz')
  assert.equal(bundleAssetName('0.1.4', 'linux', 'arm64'), '0kay-linux-arm64-v0.1.4.tar.gz')
})

test('bundle urls point at the release and honour a mirror', () => {
  assert.equal(
    bundleAssetUrl('v0.1.4', { platform: 'linux', arch: 'x64' }),
    'https://github.com/RazureSOFT/0KAY/releases/download/v0.1.4/0kay-linux-x64-v0.1.4.tar.gz',
  )
  assert.equal(
    bundleAssetUrl('0.1.4', { platform: 'win32', arch: 'arm64', mirror: 'https://gh-proxy.com/' }),
    'https://gh-proxy.com/https://github.com/RazureSOFT/0KAY/releases/download/v0.1.4/0kay-windows-arm64-v0.1.4.tar.gz',
  )
  assert.equal(
    bundleAssetUrl('0.1.4', { platform: 'linux', arch: 'x64', baseUrl: 'http://127.0.0.1:9000/' }),
    'http://127.0.0.1:9000/0kay-linux-x64-v0.1.4.tar.gz',
  )
})

test('unsupported targets ask for a source build', () => {
  assert.throws(() => bundlePlatform('freebsd', 'x64'), /--build/)
  assert.throws(() => bundlePlatform('linux', 'ia32'), /--build/)
})

test('checksums are parsed and computed', () => {
  const digest = checksumFor(Buffer.from('0kay'))
  assert.equal(digest.length, 64)
  assert.equal(parseChecksum(`${digest}  0kay-linux-x64-v0.1.4.tar.gz\n`), digest)
  assert.equal(parseChecksum('not a checksum'), null)
})
