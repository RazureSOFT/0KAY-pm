import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import zlib from 'node:zlib'

// a tarball this big is a mistake, not a slow network. bail before the
// machine starts swapping itself to death.
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MIRROR = 'https://gh-proxy.com'

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

export function resolveProxy(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

// CONNECT tunnel. Node's https.Agent cannot do this on its own, and every
// corporate proxy worth the name only speaks CONNECT for 443.
export class ProxyTunnelAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false })
    this.proxy = proxy
  }

  createConnection(options, callback) {
    const target = options.host
    const port = options.port || 443
    const headers = { Host: `${target}:${port}` }
    if (this.proxy.username) {
      const credentials = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
    }
    const request = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target}:${port}`,
      headers,
    })
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        callback(new Error(`Proxy CONNECT failed (${response.statusCode})`))
        return
      }
      callback(null, tls.connect({
        socket,
        servername: options.servername || target,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      }))
    })
    request.on('error', callback)
    request.end()
  }
}

let cachedAgent = null

export function environmentAgent() {
  const proxy = resolveProxy()
  if (!proxy) return null
  if (!cachedAgent || cachedAgent.proxy.href !== proxy.href) cachedAgent = new ProxyTunnelAgent(proxy)
  return cachedAgent
}

export function proxyAgentFor(options = {}) {
  if (options.proxyUrl) {
    const raw = String(options.proxyUrl)
    const url = resolveProxy({ HTTPS_PROXY: raw.includes('://') ? raw : `http://${raw}` })
    if (!url) throw new Error(`Unsupported proxy address: ${options.proxyUrl}`)
    return new ProxyTunnelAgent(url)
  }
  return environmentAgent()
}

function mirrorPrefix(mirror) {
  if (!mirror) return ''
  const base = typeof mirror === 'string' ? mirror : DEFAULT_MIRROR
  return String(base).replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

export function downloadOnce(url, redirects = 5, agent = null, headers = {}) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) {
      reject(new Error(`Too many redirects: ${url}`))
      return
    }
    const transport = url.startsWith('http:') ? http : https
    const request = transport.get(url, { timeout: DEFAULT_TIMEOUT_MS, agent, headers }, (response) => {
      const status = response.statusCode || 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location) {
        response.resume()
        downloadOnce(new URL(location, url).toString(), redirects - 1, agent, headers).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`Download failed (${status}): ${url}`))
        return
      }
      const chunks = []
      let total = 0
      response.on('data', (chunk) => {
        total += chunk.length
        // A tarball this big is a mistake, not a slow network. Bail instead of
        // eating the machine's memory.
        if (total > MAX_ARCHIVE_BYTES) request.destroy(new Error('Archive exceeds 512 MB'))
        else chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error(`Download timed out: ${url}`)))
    request.on('error', reject)
  })
}

export async function latestReleaseTag(owner, repo, { mirror = false, proxyUrl = null } = {}) {
  const prefix = mirrorPrefix(mirror)
  const url = `${prefix ? `${prefix}/` : ''}https://api.github.com/repos/${owner}/${repo}/releases/latest`
  try {
    const buffer = await downloadOnce(url, 5, proxyAgentFor({ proxyUrl }), {
      Accept: 'application/vnd.github+json',
      'User-Agent': '0kay-pm',
    })
    const tag = JSON.parse(buffer.toString('utf8')).tag_name
    return typeof tag === 'string' && tag ? tag : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// tar.gz
// ---------------------------------------------------------------------------

const BLOCK = 512

function headerString(header, offset, length) {
  return header.subarray(offset, offset + length).toString('utf8').split('\0')[0]
}

// pax extended headers: "<length> path=<value>\n" records, used by GitHub for
// long paths. Without this, deep node_modules trees extract to the wrong names.
function parsePax(buffer) {
  const records = {}
  let cursor = 0
  while (cursor < buffer.length) {
    const space = buffer.indexOf(0x20, cursor)
    if (space < 0) break
    const length = parseInt(buffer.subarray(cursor, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0 || cursor + length > buffer.length) break
    const record = buffer.subarray(space + 1, cursor + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    cursor += length
  }
  return records
}

export function extractTarGz(buffer, target, options = {}) {
  const allowLinks = options.links === true
  const tar = zlib.gunzipSync(buffer)
  const root = path.resolve(target)
  mkdirSync(root, { recursive: true })

  let offset = 0
  let pendingName = null
  let pendingPaxPath = null

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break

    const name = headerString(header, 0, 100)
    const prefix = headerString(header, 345, 155)
    const linkName = headerString(header, 157, 100)
    const size = parseInt(headerString(header, 124, 12).trim() || '0', 8) || 0
    const type = header[156] === 0 ? '\0' : String.fromCharCode(header[156])
    const mode = parseInt(headerString(header, 100, 8).trim() || '644', 8) || 0o644

    offset += BLOCK
    const content = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (type === 'x' || type === 'g') {
      const records = parsePax(content)
      if (records.path) pendingPaxPath = records.path
      continue
    }
    if (type === 'L') {
      pendingName = content.toString('utf8').replace(/\0+$/, '')
      continue
    }

    let relative = pendingPaxPath || pendingName || (prefix ? `${prefix}/${name}` : name)
    const isLink = type === '1' || type === '2'
    pendingPaxPath = null
    pendingName = null

    // GitHub wraps everything in <repo>-<ref>/, which the caller does not want.
    const slash = relative.indexOf('/')
    if (slash < 0) continue
    relative = relative.slice(slash + 1)
    if (!relative) continue

    const destination = path.resolve(root, relative)
    if (!destination.startsWith(root + path.sep)) throw new Error(`Archive path escapes package: ${relative}`)

    if (type === '5' || relative.endsWith('/')) {
      mkdirSync(destination, { recursive: true })
      continue
    }
    if (isLink) {
      // Symlinks are off by default: a tarball can point one at /etc and the
      // next entry happily writes through it.
      if (!allowLinks || type !== '2' || !linkName) continue
      const resolved = path.resolve(path.dirname(destination), linkName)
      if (!resolved.startsWith(root + path.sep)) continue
      mkdirSync(path.dirname(destination), { recursive: true })
      try {
        symlinkSync(linkName, destination)
      } catch {
        // Windows without developer mode; the file is optional anyway.
      }
      continue
    }
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, content, { mode: mode & 0o777 })
  }
}
