export function parsePort(name, value) {
  if (value == null) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} requires a port between 1 and 65535`)
  return port
}

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

/**
 * Bind address for Core and/or WebUI when the user opts to expose them.
 * `0.0.0.0` listens on every interface; empty/undefined keeps loopback.
 */
export function bindEnv(host, name) {
  const env = {}
  if (!host) return env
  const core = name === '@razuresoft/0kay' || name === '@razuresoft/0kay-core'
  const webui = name === '@razuresoft/0kay' || name === '@razuresoft/0kay-webui'
  if (core) env.CORE_BIND_HOST = host
  if (webui) env.WEBUI_HOST = host
  return env
}

