import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parseTarget, looksLikePath, readLocalName } from '../src/target.mjs'
import { installPackage } from '../src/installer.mjs'

// `install @D:/0KAY` used to be read as a package named "@D:/0KAY" and failed at
// the network step, with nothing saying the argument was the problem.

const onlyDirs = (dirs) => (candidate) => dirs.includes(candidate)

test('a leading @ marks a path', () => {
  const target = parseTarget('@D:/0KAY', { exists: onlyDirs(['D:/0KAY']) })
  assert.equal(target.name, null)
  assert.equal(target.source, path.resolve('D:/0KAY'))
})

test('a scoped package name is still a package', () => {
  const target = parseTarget('@razuresoft/0kay', { exists: () => false })
  assert.equal(target.name, '@razuresoft/0kay')
  assert.equal(target.source, undefined)
})

test('a version after a scoped name still parses', () => {
  const target = parseTarget('@razuresoft/0kay@1.2.3', { exists: () => false })
  assert.equal(target.name, '@razuresoft/0kay')
  assert.equal(target.version, '1.2.3')
})

test('relative and absolute paths work without the @ too', () => {
  assert.equal(parseTarget('./checkout', { exists: () => true }).source, path.resolve('checkout'))
  assert.equal(parseTarget('/srv/checkout', { exists: () => false }).source, path.resolve('/srv/checkout'))
})

test('owner/repo stays a repository shorthand when nothing is on disk', () => {
  const target = parseTarget('razuresoft/0kay', { exists: () => false })
  assert.equal(target.name, 'razuresoft/0kay')
  assert.equal(target.source, undefined)
})

test('a UNC path is a path', () => {
  const target = parseTarget('@//server/share/pkg', { exists: () => false })
  assert.ok(target.source)
})

test('looksLikePath does not claim every slash', () => {
  assert.equal(looksLikePath('razuresoft/0kay', () => false), false)
  assert.equal(looksLikePath('/srv/x', () => false), true)
  assert.equal(looksLikePath('C:\\x', () => false), true)
  assert.equal(looksLikePath('./x', () => false), true)
})

test('readLocalName reads the manifest, and says so when there is none', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-pm-target-'))
  try {
    assert.throws(() => readLocalName(root), /No manifest\.json/)
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ schema: 1, name: '@razuresoft/0kay-life', version: '1' }))
    assert.equal(readLocalName(root), '@razuresoft/0kay-life')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('installing from @<path> uses the name inside the tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-pm-atpath-'))
  try {
    const source = path.join(root, 'checkout')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ schema: 1, name: '@razuresoft/0kay-example', version: '0.9.9' }))

    const target = parseTarget(`@${source}`, { exists: (candidate) => candidate === source })
    assert.equal(target.source, path.resolve(source))

    const name = readLocalName(target.source)
    const state = { installed: {} }
    const record = await installPackage(name, { home: path.join(root, 'home'), source: target.source }, state)
    assert.equal(record.name, '@razuresoft/0kay-example')
    assert.equal(record.version, '0.9.9')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
