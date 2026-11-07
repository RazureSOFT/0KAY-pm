import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import https from 'https'

/**
 * The local Core, as pm reaches it.
 *
 * Separate from discovery's pinnedRequest on purpose: that one exists to make
 * pairing safe over an untrusted LAN (TLS pinned to a fingerprint, POST only).
 * This one talks to a Core on this machine, over the address the install already
 * recorded, and needs GET as well.
 */
export function localCore(state = {}) {
  const record = (state.packages || []).find((entry) => entry?.name === '@razuresoft/0kay' || entry?.name === '0kay') || null
  const env = record?.runtime_env || {}
  const raw = env.CORE_HTTP_ADDR || process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080'
  let url
  try {
    url = new URL(raw)
  } catch {
    url = new URL('http://127.0.0.1:8080')
  }
  const token = process.env.CORE_API_TOKEN || record?.api_token || readToken(state, record)
  return { url, token }
}

/**
 * The API token the install was given.
 *
 * An installed Core writes one into its data directory on first start; a
 * development checkout keeps it in .run/api-token. Both are tried, and a
 * missing token is not fatal because loopback is trusted by default.
 */
function readToken(state, record) {
  const candidates = []
  if (record?.data_dir) candidates.push(path.join(record.data_dir, 'device-token'))
  if (state.home) {
    candidates.push(path.join(state.home, 'data', 'device-token'))
    candidates.push(path.join(state.home, 'resources', '0kay', 'data', 'device-token'))
  }
  candidates.push(path.join(os.homedir(), '.0kay', 'data', 'device-token'))
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf-8').trim()
      if (value) return value
    } catch {
    }
  }
  return ''
}

function request(core, method, apiPath, body) {
  const transport = core.url.protocol === 'https:' ? https : http
  const payload = body === undefined ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: core.url.hostname,
      port: core.url.port || (core.url.protocol === 'https:' ? 443 : 80),
      path: apiPath,
      method,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        ...(core.token ? { Authorization: `Bearer ${core.token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30_000,
    }, (response) => {
      let data = ''
      response.setEncoding('utf-8')
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        let parsed = null
        try {
          parsed = data ? JSON.parse(data) : null
        } catch {
        }
        if (response.statusCode >= 400) {
          const message = parsed?.message || parsed?.error || data || `HTTP ${response.statusCode}`
          reject(new Error(`${message} (${response.statusCode})`))
          return
        }
        resolve(parsed)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Core did not answer in 30s; is it running?')))
    if (payload) req.write(payload)
    req.end()
  })
}

export const listExtensions = (core) => request(core, 'GET', '/api/agent/extensions')
export const enableExtensions = (core, body) => request(core, 'POST', '/api/agent/extensions/enable', body)
export const installExtension = (core, body) => request(core, 'POST', '/api/agent/extensions/install', body)
export const removeExtension = (core, body) => request(core, 'POST', '/api/agent/extensions/remove', body)
