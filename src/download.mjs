import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import zlib from 'node:zlib'

/** Environment HTTP proxy for downloads: HTTPS_PROXY, HTTP_PROXY or ALL_PROXY. */
export function resolveProxy(env=process.env){
 const raw=env.HTTPS_PROXY||env.https_proxy||env.HTTP_PROXY||env.http_proxy||env.ALL_PROXY||env.all_proxy
 if(!raw)return null
 try{
  const url=new URL(raw)
  return url.protocol==='http:'||url.protocol==='https:'?url:null
 }catch{return null}
}
/** https.Agent that tunnels connections through an HTTP CONNECT proxy. */
export class ProxyTunnelAgent extends https.Agent{
 constructor(proxy){super({keepAlive:false});this.proxy=proxy}
 createConnection(options,callback){
  const target=options.host
  const port=options.port||443
  const headers={Host:`${target}:${port}`}
  if(this.proxy.username)headers['Proxy-Authorization']=`Basic ${Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString('base64')}`
  const connect=http.request({host:this.proxy.hostname,port:this.proxy.port||(this.proxy.protocol==='https:'?443:80),method:'CONNECT',path:`${target}:${port}`,headers})
  connect.on('connect',(response,socket)=>{
   if(response.statusCode!==200){socket.destroy();callback(new Error(`Proxy CONNECT failed (${response.statusCode})`));return}
   callback(null,tls.connect({socket,servername:options.servername||target,rejectUnauthorized:options.rejectUnauthorized!==false}))
  })
  connect.on('error',callback)
  connect.end()
 }
}
let cachedAgent
/** Reuse one tunnel agent per proxy URL; null when no proxy is configured. */
export function environmentAgent(){
 const proxy=resolveProxy()
 if(!proxy)return null
 if(!cachedAgent||cachedAgent.proxy.href!==proxy.href)cachedAgent=new ProxyTunnelAgent(proxy)
 return cachedAgent
}
/** Agent for an explicit --proxy address, otherwise the environment proxy. */
export function proxyAgentFor(options){
 if(options.proxyUrl){
  const raw=String(options.proxyUrl)
  const url=resolveProxy({HTTPS_PROXY:raw.includes('://')?raw:`http://${raw}`})
  if(!url)throw new Error(`Unsupported proxy address: ${options.proxyUrl}`)
  return new ProxyTunnelAgent(url)
 }
 return environmentAgent()
}
/** One HTTPS GET with redirect following; resolves the full body buffer. */
export function downloadOnce(url,redirects=5,agent=null,headers={}){
 return new Promise((resolve,reject)=>{
  if(redirects<0){reject(new Error(`Too many redirects: ${url}`));return}
  const request=https.get(url,{timeout:120000,agent,headers},response=>{
   const status=response.statusCode||0
   if(status>=300&&status<400&&response.headers.location){
    response.resume()
    downloadOnce(new URL(response.headers.location,url).toString(),redirects-1,agent,headers).then(resolve,reject)
    return
   }
   if(status!==200){response.resume();reject(new Error(`Download failed (${status}): ${url}`));return}
   const chunks=[];let total=0
   response.on('data',chunk=>{total+=chunk.length;if(total>512*1024*1024){request.destroy(new Error('Archive exceeds 512 MB'))}else{chunks.push(chunk)}})
   response.on('end',()=>resolve(Buffer.concat(chunks)))
   response.on('error',reject)
  })
  request.on('timeout',()=>request.destroy(new Error(`Download timed out: ${url}`)))
  request.on('error',reject)
 })
}
function tarString(header,offset,length){return header.subarray(offset,offset+length).toString('utf8').split('\0')[0]}
function parsePax(buffer){
 const records={};let cursor=0
 while(cursor<buffer.length){
  const space=buffer.indexOf(0x20,cursor);if(space<0)break
  const length=parseInt(buffer.subarray(cursor,space).toString('ascii'),10)
  if(!Number.isFinite(length)||length<=0||cursor+length>buffer.length)break
  const record=buffer.subarray(space+1,cursor+length-1).toString('utf8')
  const equals=record.indexOf('=');if(equals>0)records[record.slice(0,equals)]=record.slice(equals+1)
  cursor+=length
 }
 return records
}
/**
 * Extract a GitHub source tarball (single top-level directory) into target.
 * With options.links, symlinks/hardlinks are materialized (needed for runtime
 * toolchains such as Node, whose bin/npm and bin/npx are symlinks). Links that
 * resolve outside the extraction root are skipped.
 */
export function extractTarGz(buffer,target,options={}){
 const links=options.links===true
 const tar=zlib.gunzipSync(buffer)
 const root=path.resolve(target);mkdirSync(root,{recursive:true})
 let offset=0,longName=null,paxPath=null
 while(offset+512<=tar.length){
  const header=tar.subarray(offset,offset+512)
  if(header.every(byte=>byte===0))break
  const name=tarString(header,0,100)
  const prefix=tarString(header,345,155)
  const linkName=tarString(header,157,100)
  const size=parseInt(tarString(header,124,12).trim()||'0',8)||0
  const rawType=header[156]
  const type=rawType===0?'\0':String.fromCharCode(rawType)
  const mode=parseInt(tarString(header,100,8).trim()||'644',8)||0o644
  offset+=512
  const content=tar.subarray(offset,offset+size)
  offset+=Math.ceil(size/512)*512
  if(type==='x'||type==='g'){const records=parsePax(content);if(records.path)paxPath=records.path;continue}
  if(type==='L'){longName=content.toString('utf8').replace(/\0+$/,'');continue}
  let relative=paxPath||longName||(prefix?`${prefix}/${name}`:name)
  const isLink=type==='1'||type==='2'
  paxPath=null;longName=null
  const slash=relative.indexOf('/')
  if(slash<0)continue // top-level directory entry
  relative=relative.slice(slash+1)
  if(!relative)continue
  const destination=path.resolve(root,relative)
  if(!destination.startsWith(root+path.sep))throw new Error(`Archive path escapes package: ${relative}`)
  if(type==='5'||relative.endsWith('/')){mkdirSync(destination,{recursive:true});continue}
  if(isLink){
   if(!links||type!=='2'||!linkName)continue
   const resolved=path.resolve(path.dirname(destination),linkName)
   if(!resolved.startsWith(root+path.sep))continue // never link outside the tree
   mkdirSync(path.dirname(destination),{recursive:true})
   try{symlinkSync(linkName,destination)}catch{}
   continue
  }
  mkdirSync(path.dirname(destination),{recursive:true})
  writeFileSync(destination,content,{mode:mode&0o777})
 }
}
