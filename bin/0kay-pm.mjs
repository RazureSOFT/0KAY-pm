#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import {discover,pinnedRequest} from '../src/discovery.mjs'
import {installPackage,run,validateManifest,within} from '../src/installer.mjs'
import {parsePort,portEnv} from '../src/env.mjs'

const args=process.argv.slice(2)
if(args[0]?.startsWith('install@'))args.splice(0,1,'install',args[0].slice(7))
const home=process.env.OKAY_PM_HOME||path.join(os.homedir(),'.0kay')
await fs.mkdir(home,{recursive:true,mode:0o700})
const statePath=path.join(home,'state.json')
let state={cores:{},installed:{},pairings:{}}
try{state={...state,...JSON.parse(await fs.readFile(statePath,'utf8'))}}catch(error){if(error.code!=='ENOENT')throw error}
const save=async()=>{await fs.writeFile(statePath+'.tmp',JSON.stringify(state,null,2),{mode:0o600});await fs.rename(statePath+'.tmp',statePath)}
const ask=async question=>{if(!process.stdin.isTTY)throw new Error('Interactive terminal required for pairing');const rl=readline.createInterface({input:process.stdin,output:process.stdout});try{return(await rl.question(question)).trim()}finally{rl.close()}}
const flag=name=>{const index=args.indexOf(name);return index<0?null:args[index+1]}
/** package[@version] → {name, version}; --version flags the same pin. */
function parseTarget(raw){
 if(!raw||raw.startsWith('-'))return {name:raw||null,version:flag('--version')}
 const at=raw.lastIndexOf('@')
 const name=at>0?raw.slice(0,at):raw
 const version=at>0?raw.slice(at+1):flag('--version')
 return {name,version:version?version.replace(/^v/,''):null}
}
const coreDataRoot=()=>path.join(state.installed['@razuresoft/0kay']?.repositoryRoot||path.join(home,'packages','0kay'),'core','data')
/** --proxy alone mirrors via gh-proxy.com; --proxy host:port tunnels through that proxy. */
const proxyValue=flag('--proxy')
const proxyUrl=proxyValue&&!proxyValue.startsWith('--')&&/[:/]/.test(proxyValue)?proxyValue:null
const proxyMirror=args.includes('--proxy')&&!proxyUrl
const askPort=async(label,def)=>{while(true){const raw=await ask(`${label} [${def}]: `);if(!raw)return def;try{return parsePort(label,raw)}catch(error){console.log(error.message)}}}
/** Ports are asked interactively during install; flags override for scripts. */
async function portChoices(name){
 const choices={}
 const wantsCore=name==='@razuresoft/0kay'||name==='@razuresoft/0kay-core'
 const wantsWebui=name==='@razuresoft/0kay'||name==='@razuresoft/0kay-webui'
 if(process.stdin.isTTY){
  if(wantsCore&&flag('--core-port')==null)choices.http=await askPort('Core HTTP port',8080)
  if(wantsCore&&flag('--core-grpc-port')==null)choices.grpc=await askPort('Core gRPC port',50051)
  if(wantsWebui&&flag('--webui-port')==null)choices.webui=await askPort('WebUI port',3000)
 }
 if(choices.http==null)choices.http=parsePort('--core-port',flag('--core-port'))
 if(choices.grpc==null)choices.grpc=parsePort('--core-grpc-port',flag('--core-grpc-port'))
 if(choices.webui==null)choices.webui=parsePort('--webui-port',flag('--webui-port'))
 return choices
}
async function scan(){const cores=await discover();for(const core of cores){const old=state.cores[core.id];if(old&&old.fingerprint!==core.fingerprint)core.identity_changed=true;state.cores[core.id]=core}await save();return cores}
async function pair(cores){
 if(!cores.length){console.log('No LAN Core discovered. Start Core with CORE_LAN_ENABLED=1; UDP 50050 and TLS 8443/5443 must be reachable.');return null}
 cores.forEach((core,index)=>console.log(`${index+1}. ${core.name} ${core.host} [${core.id}] fingerprint ${core.fingerprint}${core.identity_changed?' CHANGED':''}`))
 const selected=flag('--core')?cores.find(core=>core.id===flag('--core')):cores[Number(await ask('Choose Core number (Enter skips pairing): '))-1]
 if(!selected)return null
 if(selected.identity_changed)throw new Error('Core identity changed; investigate before pairing')
 if(state.pairings[selected.id])return {...selected,...state.pairings[selected.id]}
 if((await ask(`Pair with ${selected.name} (${selected.host})? [y/N] `)).toLowerCase()!=='y')return null
 const request=await pinnedRequest(selected,'/api/pairing/request',{name:os.hostname()})
 console.log(`Pairing code: ${request.code}. On the Core computer open Settings → Devices and approve this same code. Waiting up to five minutes.`)
 const deadline=Date.now()+300000
 while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1500));const result=await pinnedRequest(selected,'/api/pairing/status',{id:request.id,secret:request.secret});if(result.approved){
  const cert=path.join(home,`core-${selected.id}.crt`);await fs.writeFile(cert,result.certificate,{mode:0o600})
  state.pairings[selected.id]={token:result.token,certificate:cert,server_name:result.server_name};await save();return {...selected,...state.pairings[selected.id]}
 }}throw new Error('Pairing timed out')
}
async function configure(record,core,choices){
 const env={}
 if(core){const interfaces=Object.values(os.networkInterfaces()).flat().filter(value=>value&&value.family==='IPv4'&&!value.internal);const address=flag('--advertise')||interfaces.find(value=>value.address.split('.').slice(0,3).join('.')===core.host.split('.').slice(0,3).join('.'))?.address
  if(!address)throw new Error('Cannot determine callback address; pass --advertise <LAN-IP>')
   Object.assign(env,{CORE_ADDRESS:`${core.host}:${core.grpc_port}`,CORE_HTTP_ADDR:`https://${core.host}:${core.http_port}`,CORE_PAIR_TOKEN:core.token,CORE_TLS_CA:core.certificate,CORE_TLS_NAME:core.server_name,NODE_EXTRA_CA_CERTS:core.certificate,AGENT_ADDRESS:`${address}:50054`,AGENT_BIND_HOST:'0.0.0.0',MOCR_ADDRESS:`${core.host}:${core.grpc_port}`})
  }
  Object.assign(env,portEnv(choices,Boolean(core)))
  if(record.name==='@razuresoft/0kay'||record.name==='@razuresoft/0kay-core')env.CORE_LAN_ENABLED='1'
 await fs.writeFile(path.join(record.repositoryRoot,'runtime-env.json'),JSON.stringify(env,null,2),{mode:0o600})
}
async function startInstalled(record){
 const env=JSON.parse(await fs.readFile(path.join(record.repositoryRoot,'runtime-env.json'),'utf8'))
 const commands=[]
 if(record.modules.length){
  for(const relative of record.modules){
   const manifestPath=within(record.repositoryRoot,relative)
   const manifest=validateManifest(JSON.parse(await fs.readFile(manifestPath,'utf8')))
   if(manifest.start)commands.push({command:manifest.start,cwd:path.dirname(manifestPath)})
  }
 }else if(record.start)commands.push({command:record.start,cwd:record.cwd})
 if(!commands.length){console.log('Library/UI package; no standalone process.');return}
 console.log(`Starting ${record.name}. Services run in this terminal; press Ctrl+C to stop.`)
 await Promise.all(commands.map(({command,cwd})=>run(command,cwd,env)))
}
try{
 switch(args[0]){
 case 'discover':console.log(JSON.stringify(await scan(),null,2));break
 case 'cores':console.log(JSON.stringify(state.cores,null,2));break
 case 'install':{
  const cores=await scan(); // Mandatory discovery before every install, even offline/local.
  const target=parseTarget(args[1]);if(!target.name)throw new Error('Usage: 0kay-pm install <package>[@version] [--proxy] [--source <local-tree>] [--no-pair]')
  const core=args.includes('--no-pair')?null:await pair(cores)
  const choices=await portChoices(target.name)
  console.log(`Installing ${target.name}${target.version?`@${target.version}`:''}. Package manifests run build/install commands from the selected repository.`)
  const record=await installPackage(target.name,{home,source:flag('--source'),proxy:proxyMirror,proxyUrl,tag:target.version?`v${target.version}`:null,coreData:coreDataRoot()},state)
   await configure(record,core,choices);await save();console.log(`Installed ${record.name}@${record.version}.`)
   await startInstalled(record);break
 }
 case 'update':{
  const target=parseTarget(args[1]);if(!target.name)throw new Error('Usage: 0kay-pm update <package>[@version] [--proxy] [--source <local-tree>]')
  if(!state.installed[target.name])throw new Error(`${target.name} is not installed`)
  console.log(`Updating ${target.name}${target.version?`@${target.version}`:' to the latest main branch'}.`)
  const record=await installPackage(target.name,{home,source:flag('--source'),proxy:proxyMirror,proxyUrl,reinstall:true,tag:target.version?`v${target.version}`:null,coreData:coreDataRoot()},state)
  await save();console.log(`Updated ${record.name}@${record.version}. Start: 0kay-pm start ${record.name}`);break
 }
 case 'start':{
  const record=state.installed[args[1]];if(!record)throw new Error('Package not installed')
   await startInstalled(record)
  break
 }
  default:console.log('0kay-pm install <package>[@version] [--proxy [host:port]] [--source <local-tree>] [--no-pair] [--core-port <n>] [--core-grpc-port <n>] [--webui-port <n>]\n0kay-pm update <package>[@version] [--proxy [host:port]] [--source <local-tree>]\n0kay-pm discover\n0kay-pm cores\n0kay-pm start <package>\nPorts are asked interactively on install; the flags override for scripts.\n--proxy alone downloads via the gh-proxy.com mirror; with host:port or a URL it tunnels through that HTTP proxy. HTTPS_PROXY is honored too.')
 }
}catch(error){console.error(error.message);process.exitCode=1}
