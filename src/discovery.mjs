import dgram from 'node:dgram'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import https from 'node:https'

const DISCOVERY_PORT = 50050
const PROTOCOL = '0kay-discover-v1'
const RESPONSE_PROTOCOL = '0kay-core-v1'
const MAX_RESPONSE_BYTES = 1024 * 1024

function ipv4Interfaces() {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
}

function maskBits(netmask) {
  return netmask
    .split('.')
    .map(Number)
    .reduce((total, octet) => total + octet.toString(2).split('1').length - 1, 0)
}

function broadcastAddress(address, netmask) {
  const ip = address.split('.').map(Number)
  const mask = netmask.split('.').map(Number)
  return ip.map((value, index) => value | (~mask[index] & 255)).join('.')
}

export function localSubnets() {
  return [...new Set(ipv4Interfaces().map((entry) => `${entry.address}/${maskBits(entry.netmask)}`))]
}

// A /16 is 65k hosts, which is not a scan, it is a denial of service on your own
// switch. Cap it and let the caller raise the ceiling if they mean it.
export function expandTargets(entries, maxHosts = 1024) {
  const out = new Set()
  for (const raw of entries || []) {
    const entry = String(raw ?? '').trim()
    if (!entry) continue
    const cidr = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
    if (!cidr) {
      out.add(entry)
      continue
    }
    const [, base, prefixText] = cidr
    const prefix = Number(prefixText)
    const parts = base.split('.').map(Number)
    if (prefix < 0 || prefix > 32 || parts.some((value) => value > 255)) {
      out.add(entry)
      continue
    }
    const baseNumber = parts.reduce((acc, value) => ((acc << 8) + value) >>> 0, 0)
    const shift = 32 - prefix
    const mask = prefix === 0 ? 0 : shift >= 32 ? 0xffffffff : (~0 << shift) >>> 0
    const network = (baseNumber & mask) >>> 0
    const count = Math.min(2 ** shift, maxHosts)
    for (let index = 0; index < count; index++) {
      const value = (network + index) >>> 0
      out.add([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'))
    }
  }
  return [...out]
}

export async function discover(timeout = 1600, extraTargets = [], { broadcast = true } = {}) {
  const socket = dgram.createSocket('udp4')
  const nonce = randomUUID()
  const found = new Map()

  socket.on('error', () => {})
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '0.0.0.0', resolve)
  })
  socket.setBroadcast(true)

  // A response is only trusted when it echoes our nonce: otherwise any device on
  // the LAN can advertise itself as a Core and collect the pairing handshake.
  socket.on('message', (raw, remote) => {
    try {
      const value = JSON.parse(raw)
      if (value.protocol !== RESPONSE_PROTOCOL) return
      if (value.nonce !== nonce) return
      if (!/^[a-f0-9]{64}$/.test(value.fingerprint)) return
      if (!Number.isInteger(value.http_port) || !Number.isInteger(value.grpc_port)) return
      found.set(value.id, { ...value, host: remote.address, last_seen: new Date().toISOString() })
    } catch {
      // Some other UDP noise on the port. Ignore it.
    }
  })

  const targets = new Set()
  if (broadcast) {
    targets.add('127.0.0.1')
    targets.add('255.255.255.255')
    for (const entry of ipv4Interfaces()) targets.add(broadcastAddress(entry.address, entry.netmask))
  }
  for (const address of extraTargets || []) if (address) targets.add(String(address))
  if (!targets.size) return []

  const payload = Buffer.from(JSON.stringify({ protocol: PROTOCOL, nonce }))
  for (const address of targets) socket.send(payload, DISCOVERY_PORT, address, () => {})
  await new Promise((resolve) => setTimeout(resolve, timeout))
  socket.close()
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// Pairing goes over TLS pinned to the fingerprint discovery reported. Without
// the pin, a machine that wins the ARP race owns the pairing token.
export function pinnedRequest(core, path, body, token = '') {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: core.host,
      port: core.http_port,
      path,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 10_000,
    }, (response) => {
      let data = ''
      response.on('error', reject)
      response.on('data', (chunk) => {
        data += chunk
        if (data.length > MAX_RESPONSE_BYTES) response.destroy(new Error('response too large'))
      })
      response.on('end', () => {
        if (response.statusCode >= 400) {
          reject(new Error(`${response.statusCode}: ${data}`))
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('socket', (socket) => socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate()
      const fingerprint = (certificate.fingerprint256 || '').replaceAll(':', '').toLowerCase()
      if (fingerprint !== core.fingerprint) request.destroy(new Error('Core certificate fingerprint changed'))
    }))
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('Core request timed out')))
    request.end(JSON.stringify(body))
  })
}
