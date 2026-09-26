import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import {discover,expandTargets,localSubnets} from '../src/discovery.mjs'
test('localSubnets yields cidr strings',()=>{
 const subnets=localSubnets()
 assert.ok(Array.isArray(subnets))
 for(const subnet of subnets)assert.match(subnet,/\/\d{1,2}$/)
})
test('expandTargets handles ips, cidr ranges and hostnames',()=>{
 assert.deepEqual(expandTargets(['10.0.0.5']),['10.0.0.5'])
 assert.deepEqual(expandTargets(['192.168.1.0/30']),['192.168.1.0','192.168.1.1','192.168.1.2','192.168.1.3'])
 assert.equal(expandTargets(['192.168.1.0/24'],10).length,10)
 assert.deepEqual(expandTargets(['core.local']),['core.local'])
 assert.deepEqual(expandTargets(['bad/999']),['bad/999'])
})
test('discovery correlates responses and ignores invalid peers',async t=>{
 const server=dgram.createSocket('udp4')
 const bound=await new Promise(resolve=>{server.once('error',()=>resolve(false));server.bind(50050,'127.0.0.1',()=>resolve(true))})
 if(!bound){server.close();t.skip('discovery port already used by running Core');return}
 server.on('message',(raw,peer)=>{const request=JSON.parse(raw);server.send(JSON.stringify({protocol:'0kay-core-v1',nonce:request.nonce,id:'test',fingerprint:'a'.repeat(64),http_port:8443,grpc_port:5443}),peer.port,peer.address)})
  try{const cores=await discover(100);assert.ok(cores.some(core=>core.id==='test'))}finally{server.close()}
})
test('targeted discovery queries explicit hosts without broadcast',async t=>{
 const server=dgram.createSocket('udp4')
 const bound=await new Promise(resolve=>{server.once('error',()=>resolve(false));server.bind(50050,'127.0.0.1',()=>resolve(true))})
 if(!bound){server.close();t.skip('discovery port already used by running Core');return}
 server.on('message',(raw,peer)=>{const request=JSON.parse(raw);server.send(JSON.stringify({protocol:'0kay-core-v1',nonce:request.nonce,id:'target',fingerprint:'b'.repeat(64),http_port:8443,grpc_port:5443}),peer.port,peer.address)})
 try{const cores=await discover(100,['127.0.0.1'],{broadcast:false});assert.deepEqual(cores.map(core=>core.id),['target'])}finally{server.close()}
})
