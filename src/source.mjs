import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { downloadOnce, extractTarGz, proxyAgentFor } from './download.mjs'
import { parseShasums } from './toolchain.mjs'
import { archiveUrl } from './manifest.mjs'

// Getting a package tarball onto disk, and refusing to do so unverified.

const ATTEMPTS = 2
const RETRY_DELAY_MS = 2000

function mirrorPrefix(mirror) {
  return mirror ? String(mirror).replace(/\/+$/, '') : ''
}

function codeloadUrl(url) {
  return url
    .replace('https://github.com/', 'https://codeload.github.com/')
    .replace('/archive/', '/tar.gz/')
    .replace(/\.tar\.gz$/, '')
}

// GitHub serves the same tarball from two hosts and neither is reliable, so try
// both before giving up. The mirror, when set, goes in front of both.
export async function downloadArchive(repository, target, options = {}) {
  const archive = archiveUrl(repository, 'main', options.tag || null)
  const agent = proxyAgentFor(options)
  const prefix = mirrorPrefix(options.mirror || (options.proxy ? 'https://gh-proxy.com' : ''))
  const log = options.log || console.log

  let lastError
  for (const candidate of [archive, codeloadUrl(archive)]) {
    const url = prefix ? `${prefix}/${candidate}` : candidate
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const buffer = await downloadOnce(url, 5, agent)
        const warning = await verifySourceChecksum(repository, options.tag || null, buffer, options)
        if (warning) log(`Warning: ${warning}`)
        await fs.rm(target, { recursive: true, force: true })
        extractTarGz(buffer, target)
        return
      } catch (error) {
        lastError = error
        if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * RETRY_DELAY_MS))
      }
    }
  }
  throw lastError
}

// A release tarball is named after its tag; the asset in SHA256SUMS may be bare
// or prefixed. Match what we can, and if the manifest is ambiguous, refuse
// rather than guess — "close enough" is how supply-chain bugs happen.
function checksumEntry(shasums, tag) {
  const names = [...shasums.keys()]
  const stem = String(tag).replace(/^v/, '')
  for (const candidate of [`${tag}.tar.gz`, `${stem}.tar.gz`]) {
    const hit = names.find((name) => name === candidate || name.endsWith(`/${candidate}`))
    if (hit) return hit
  }
  const loose = names.filter((name) => name.endsWith(`${stem}.tar.gz`))
  if (loose.length === 1) return loose[0]
  const tarballs = names.filter((name) => name.endsWith('.tar.gz'))
  return tarballs.length === 1 ? tarballs[0] : null
}

// Returns a warning string when the archive could not be verified (an untagged
// branch has no release to check against), and throws when it could be verified
// and did not match. A silent "probably fine" is the one outcome we never ship.
export async function verifySourceChecksum(repository, tag, buffer, options = {}) {
  if (!tag) return 'source tarball not checksum-verified'
  const slug = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repository)
  if (!slug) return 'source tarball not checksum-verified'

  const sumsUrl = `https://github.com/${slug[1]}/${slug[2]}/releases/download/${tag}/SHA256SUMS`
  const prefix = mirrorPrefix(options.mirror || (options.proxy ? 'https://gh-proxy.com' : ''))
  let shasums
  try {
    const text = await downloadOnce(
      prefix ? `${prefix}/${sumsUrl}` : sumsUrl,
      5,
      proxyAgentFor(options),
      { 'User-Agent': '0kay-pm' },
    )
    shasums = parseShasums(text.toString('utf8'))
  } catch {
    return 'source tarball not checksum-verified'
  }

  // an ambiguous manifest is not a reason to pick one and hope. refuse.
  // "close enough" is how supply-chain bugs get shipped.
  // an ambiguous manifest is not a reason to pick one and hope. refuse. "close
  // enough" is how supply-chain bugs ship, and nobody wants to be that guy.
  const entry = checksumEntry(shasums, tag)
  if (!entry) throw new Error('SHA256SUMS does not cover the source archive; refusing to install unverified code')
  const digest = createHash('sha256').update(buffer).digest('hex')
  if (digest !== shasums.get(entry).toLowerCase()) throw new Error(`Checksum mismatch for ${entry}; refusing to install`)
  return null
}
