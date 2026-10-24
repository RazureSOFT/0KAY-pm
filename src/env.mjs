const MIN_PORT = 1
const MAX_PORT = 65535

const CORE_PACKAGES = new Set(['@razuresoft/0kay', '@razuresoft/0kay-core'])
const WEBUI_PACKAGES = new Set(['@razuresoft/0kay', '@razuresoft/0kay-webui'])

export function parsePort(name, value) {
  if (value == null) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`${name} requires a port between ${MIN_PORT} and ${MAX_PORT}`)
  }
  return port
}

// A paired install talks to a Core on another machine, so it must not pin the
// loopback addresses: the pairing record already carries the real ones, and an
// env file that overrides them sends the plugins to the wrong box.
export function portEnv(ports, paired) {
  const env = {}
  if (ports.http != null) {
    env.CORE_HTTP_PORT = String(ports.http)
    if (!paired) env.CORE_HTTP_ADDR = `http://127.0.0.1:${ports.http}`
  }
  if (ports.grpc != null) {
    env.CORE_GRPC_PORT = String(ports.grpc)
    if (!paired) env.CORE_ADDRESS = `localhost:${ports.grpc}`
  }
  if (ports.webui != null) env.WEBUI_PORT = String(ports.webui)
  return env
}

// Only the packages that actually open a listener get a bind host. Setting it
// on a plugin would be harmless, but it reads like the plugin is exposed.
export function bindEnv(host, name) {
  const env = {}
  if (!host) return env
  if (CORE_PACKAGES.has(name)) env.CORE_BIND_HOST = host
  if (WEBUI_PACKAGES.has(name)) env.WEBUI_HOST = host
  return env
}
