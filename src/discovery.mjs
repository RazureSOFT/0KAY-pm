import dgram from 'node:dgram'
import os from 'node:os'
import {randomUUID} from 'node:crypto'
import https from 'node:https'

/** CIDR strings for every non-internal IPv4 interface (the host's own LANs). */
export function localSubnets(){
 const out=[]
 for(const entries of Object.values(os.networkInterfaces()))for(const entry of entries||[]){
  if(entry.family!=='IPv4'||entry.internal)continue
  const ones=entry.netmask.split('.').map(Number).reduce((acc,value)=>acc+value.toString(2).split('1').length-1,0)
  out.push(`${entry.address}/${ones}`)
 }
 return [...new Set(out)]
}

/** Expand "10.0.0.5", "10.0.0.0/24" or a hostname into concrete probe targets. */
export function expandTargets(entries, maxHosts=1024) {
 const out=new Set()
 for(const raw of entries||[]){
  const entry=String(raw??'').trim(); if(!entry)continue
  const cidr=entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if(!cidr){out.add(entry);continue}
  const [,base,prefixText]=cidr, prefix=Number(prefixText)
  const parts=base.split('.').map(Number)
  if(prefix<0||prefix>32||parts.some(value=>value>255)){out.add(entry);continue}
  const baseNum=parts.reduce((acc,value)=>((acc<<8)+value)>>>0,0)
  const shift=32-prefix
  const mask=prefix===0?0:(shift>=32?0xffffffff:(~0<<shift)>>>0)
  const network=(baseNum & mask)>>>0
  const size=2**shift
  const count=Math.min(size, maxHosts)
  for(let i=0;i<count;i++){const value=(network+i)>>>0;out.add([value>>>24,(value>>>16)&255,(value>>>8)&255,value&255].join('.'))}
 }
 return [...out]
}

export async function discover(timeout=1600, extraTargets=[]) {
 const socket=dgram.createSocket('udp4'), nonce=randomUUID(), found=new Map()
 await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,'0.0.0.0',resolve)})
 socket.setBroadcast(true)
 socket.on('message',(raw,remote)=>{try{const value=JSON.parse(raw);if(value.protocol==='0kay-core-v1'&&value.nonce===nonce&&/^[a-f0-9]{64}$/.test(value.fingerprint)&&Number.isInteger(value.http_port)&&Number.isInteger(value.grpc_port))found.set(value.id,{...value,host:remote.address,last_seen:new Date().toISOString()})}catch{}})
 const targets=new Set(['127.0.0.1','255.255.255.255'])
 for(const entries of Object.values(os.networkInterfaces()))for(const entry of entries||[])if(entry.family==='IPv4'&&!entry.internal){const ip=entry.address.split('.').map(Number),mask=entry.netmask.split('.').map(Number);targets.add(ip.map((v,i)=>v|(~mask[i]&255)).join('.'))}
 for(const address of extraTargets||[])if(address)targets.add(String(address))
 const payload=Buffer.from(JSON.stringify({protocol:'0kay-discover-v1',nonce}))
 for(const address of targets) socket.send(payload,50050,address,()=>{})
 await new Promise(resolve=>setTimeout(resolve,timeout));socket.close()
 return [...found.values()].sort((a,b)=>a.id.localeCompare(b.id))
}
export function pinnedRequest(core,path,body,token='') {
 return new Promise((resolve,reject)=>{
  const request=https.request({host:core.host,port:core.http_port,path,method:'POST',rejectUnauthorized:false,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},timeout:10000},response=>{
   let data='';response.on('error',reject);response.on('data',chunk=>{data+=chunk;if(data.length>1048576)response.destroy(new Error('response too large'))});response.on('end',()=>{if(response.statusCode>=400){reject(new Error(`${response.statusCode}: ${data}`));return}try{resolve(JSON.parse(data))}catch(error){reject(error)}})
  })
  request.on('socket',socket=>socket.once('secureConnect',()=>{
   const certificate=socket.getPeerCertificate();const fingerprint=(certificate.fingerprint256||'').replaceAll(':','').toLowerCase()
   if(fingerprint!==core.fingerprint)request.destroy(new Error('Core certificate fingerprint changed'))
  }))
  request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('Core request timed out')));request.end(JSON.stringify(body))
 })
}
