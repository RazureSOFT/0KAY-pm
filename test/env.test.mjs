import assert from 'node:assert/strict'
import test from 'node:test'
import {parsePort, portEnv, bindEnv} from '../src/env.mjs'

test('parsePort accepts plain ports and returns null when absent', () => {
  assert.equal(parsePort('--core-port', undefined), null)
  assert.equal(parsePort('--core-port', '8080'), 8080)
  assert.equal(parsePort('--core-port', 1), 1)
  assert.equal(parsePort('--core-port', 65535), 65535)
})

test('parsePort rejects junk, fractions, and out-of-range values', () => {
  for (const value of ['http', '80.5', '0', '-1', '65536', '']) {
    assert.throws(() => parsePort('--core-port', value), /port between 1 and 65535/)
  }
})

test('portEnv maps local ports to listeners and outbound addresses', () => {
  assert.deepEqual(portEnv({http: 18080, grpc: 15051, webui: 3300}, false), {
    CORE_HTTP_PORT: '18080',
    CORE_HTTP_ADDR: 'http://127.0.0.1:18080',
    CORE_GRPC_PORT: '15051',
    CORE_ADDRESS: 'localhost:15051',
    WEBUI_PORT: '3300',
  })
})

test('portEnv keeps pairing addresses and still sets local listeners', () => {
  assert.deepEqual(portEnv({http: 18080, webui: 3300}, true), {
    CORE_HTTP_PORT: '18080',
    WEBUI_PORT: '3300',
  })
})

test('portEnv omits everything when no flags are given', () => {
  assert.deepEqual(portEnv({http: null, grpc: null, webui: null}, false), {})
})

test('bindEnv sets Core and WebUI bind hosts only for the packages that own them', () => {
  assert.deepEqual(bindEnv('0.0.0.0', '@razuresoft/0kay'), {CORE_BIND_HOST: '0.0.0.0', WEBUI_HOST: '0.0.0.0'})
  assert.deepEqual(bindEnv('0.0.0.0', '@razuresoft/0kay-core'), {CORE_BIND_HOST: '0.0.0.0'})
  assert.deepEqual(bindEnv('0.0.0.0', '@razuresoft/0kay-webui'), {WEBUI_HOST: '0.0.0.0'})
  assert.deepEqual(bindEnv('0.0.0.0', '@razuresoft/0kay-life'), {})
  assert.deepEqual(bindEnv(null, '@razuresoft/0kay'), {})
  assert.deepEqual(bindEnv('', '@razuresoft/0kay-webui'), {})
  assert.deepEqual(bindEnv('192.168.1.20', '@razuresoft/0kay-core'), {CORE_BIND_HOST: '192.168.1.20'})
})
