import fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {execFile} from 'node:child_process'
import {downloadOnce,extractTarGz} from './download.mjs'

/**
 * User-level build-toolchain provisioning.
 *
 * When a manifest runs a build command whose executable is missing (go, node,
 * python), the installer downloads an official, checksum-verified toolchain
 * into `~/.0kay/toolchains/<name>/<version>` and uses it for that install. It
 * never needs sudo and never touches the system toolchain. Disable with
 * `--no-toolchain-download` or `OKAY_TOOLCHAIN_DOWNLOAD=0`; skip checksum
 * verification only with `OKAY_TOOLCHAIN_INSECURE=1`.
 */
export const DEFAULT_VERSIONS={
 go:process.env.OKAY_GO_VERSION||process.env.OKAY_TOOLCHAIN_GO_VERSION||'1.23.4',
 node:process.env.OKAY_NODE_VERSION||process.env.OKAY_TOOLCHAIN_NODE_VERSION||'22.12.0',
 python:process.env.OKAY_PYTHON_VERSION||process.env.OKAY_TOOLCHAIN_PYTHON_VERSION||'3.12.7',
}
const EXECUTABLES={go:'go','go.exe':'go',node:'node','node.exe':'node',python:'python','python.exe':'python',python3:'python'}

/** Normalize process platform/arch into source archive naming. */
export function platformInfo(platform=process.platform,arch=process.arch){
 const goos=platform==='win32'?'windows':platform==='darwin'?'darwin':platform==='linux'?'linux':null
 const nodeOS=platform==='win32'?'win':platform==='darwin'?'darwin':platform==='linux'?'linux':null
 const goArch=arch==='x64'?'amd64':arch==='arm64'?'arm64':null
 const nodeArch=arch==='x64'?'x64':arch==='arm64'?'arm64':null
 const triple={linux:{x64:'x86_64-unknown-linux-gnu',arm64:'aarch64-unknown-linux-gnu'},darwin:{x64:'x86_64-apple-darwin',arm64:'aarch64-apple-darwin'},win32:{x64:'x86_64-pc-windows-msvc'}}[platform]?.[arch]||null
 if(!goos||!goArch||!nodeArch||!triple)throw new Error(`Unsupported platform: ${platform}/${arch}`)
 return {platform,arch,goos,nodeOS,goArch,nodeArch,triple}
}
export function toolchainFor(executable){
 return EXECUTABLES[String(executable).toLowerCase()]||null
}
export function isKnownToolchain(executable){
 return toolchainFor(executable)!==null
}
/** Path to the installed binary for a tool, platform aware. */
export function executablePath(tool,dir,platform=process.platform){
 if(tool==='python'){
  if(platform==='win32')return existsSync(path.join(dir,'python.exe'))?path.join(dir,'python.exe'):path.join(dir,'python','python.exe')
  for(const name of ['python3','python']){const candidate=path.join(dir,'bin',name);if(existsSync(candidate))return candidate}
  return path.join(dir,'bin','python3')
 }
 const name=tool==='go'?'go':'node'
 const file=platform==='win32'?`${name}.exe`:name
 const candidate=tool==='node'&&platform==='win32'?path.join(dir,file):path.join(dir,'bin',file)
 return candidate
}
/** Directories to prepend to PATH for a provisioned tool (bin + Scripts on Windows). */
export function binDirs(tool,dir,platform=process.platform){
 if(tool==='go')return [path.join(dir,'bin')]
 if(tool==='node')return platform==='win32'?[dir]:[path.join(dir,'bin')]
 if(tool==='python')return platform==='win32'?[dir,path.join(dir,'Scripts')]:[path.join(dir,'bin')]
 return []
}
/** Parse Node's SHASUMS256.txt into a filename → sha256 map. */
export function parseShasums(text){
 const map=new Map()
 for(const line of String(text).split(/\r?\n/)){
  const match=/^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim())
  if(match)map.set(match[2],match[1])
 }
 return map
}
export function goFilename(version,info){
 const ext=info.goos==='windows'?'zip':'tar.gz'
 return `go${version}.${info.goos}-${info.goArch}.${ext}`
}
function compareVersions(a,b){
 const pa=String(a).replace(/^go/,'').split('.').map(Number)
 const pb=String(b).replace(/^go/,'').split('.').map(Number)
 for(let index=0;index<Math.max(pa.length,pb.length);index++){
  const left=pa[index]||0,right=pb[index]||0
  if(left!==right)return left-right
 }
 return 0
}
/**
 * Choose the Go release satisfying a go.mod requirement. Prefers the exact
 * patch, then the newest patch of the same major.minor (patch releases are
 * forward compatible; go.dev only indexes the required patch in its full list).
 */
export function selectGoRelease(releases,version){
 const wanted=`go${version}`
 const exact=(releases||[]).find(release=>release.version===wanted)
 if(exact)return exact
 const [major,minor]=version.split('.')
 if(major==null||minor==null)return null
 const patches=(releases||[]).filter(release=>new RegExp(`^go${major}\\.${minor}\\.\\d+$`).test(release.version))
 if(!patches.length)return null
 return patches.sort((a,b)=>compareVersions(a.version,b.version))[patches.length-1]
}
/**
 * Choose a python-build-standalone asset for the requested version and target
 * triple. Prefers the exact version, then the newest patch of the same
 * major.minor that the current release still ships.
 */
export function selectPythonAsset(names,version,triple){
 const target=String(triple).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 const pattern=new RegExp(`^cpython-(\\d+\\.\\d+\\.\\d+)\\+.+-${target}-install_only\\.tar\\.gz$`)
 const matches=(names||[]).map(name=>pattern.exec(name)).filter(Boolean)
 if(!matches.length)return null
 const exact=matches.find(match=>match[1]===version)
 if(exact)return exact.input
 const [major,minor]=version.split('.')
 const same=(matches||[]).filter(match=>match[1].startsWith(`${major}.${minor}.`))
 if(!same.length)return null
 same.sort((a,b)=>compareVersions(a[1],b[1]))
 return same[same.length-1].input
}
export function nodeFilename(version,info){
 const ext=info.nodeOS==='win'?'zip':'tar.gz'
 return `node-v${version}-${info.nodeOS}-${info.nodeArch}.${ext}`
}
/** Read the required Go version from a go.mod at/above cwd, if present. */
export async function requiredGoVersion(cwd){
 let dir=path.resolve(cwd||'.')
 for(let depth=0;depth<25;depth++){
  try{
   const text=await fs.readFile(path.join(dir,'go.mod'),'utf8')
   const toolchain=/^toolchain\s+go(\S+)/m.exec(text)
   const directive=/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)
   const value=(toolchain?.[1]||directive?.[1])?.trim()
   if(value)return value.split('.').length<3?`${value}.0`:value
   return null
  }catch(error){if(error.code!=='ENOENT')return null}
  const parent=path.dirname(dir)
  if(parent===dir)break
  dir=parent
 }
 return null
}
async function goAsset(version,info,agent){
 // ?mode=json only lists the current and previous stable release; include=all
 // exposes the full history so a go.mod patch requirement can be resolved.
 const releases=JSON.parse((await downloadOnce('https://go.dev/dl/?mode=json&include=all',5,agent)).toString('utf8'))
 const release=selectGoRelease(releases,version)
 const resolved=release?release.version.replace(/^go/,''):version
 const filename=goFilename(resolved,info)
 const file=(release?.files||[]).find(entry=>entry.filename===filename)
 return {filename,url:`https://go.dev/dl/${filename}`,sha256:file?.sha256||null,archive:info.goos==='windows'?'zip':'tar.gz'}
}
async function nodeAsset(version,info,agent){
 const filename=nodeFilename(version,info)
 const base=`https://nodejs.org/dist/v${version}/`
 const shasums=parseShasums((await downloadOnce(`${base}SHASUMS256.txt`,5,agent)).toString('utf8'))
 return {filename,url:base+filename,sha256:shasums.get(filename)||null,archive:info.nodeOS==='win'?'zip':'tar.gz'}
}
async function pythonAsset(version,info,agent){
 const headers={'user-agent':'0kay-pm','accept':'application/vnd.github+json'}
 const release=JSON.parse((await downloadOnce('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest',5,agent,headers)).toString('utf8'))
 const name=selectPythonAsset((release.assets||[]).map(entry=>entry.name),version,info.triple)
 if(!name)throw new Error(`No python-build-standalone asset for ${version} ${info.triple}`)
 const asset=(release.assets||[]).find(entry=>entry.name===name)
 const shaAsset=(release.assets||[]).find(entry=>entry.name===`${name}.sha256`)
 let sha256=null
 if(shaAsset){const body=(await downloadOnce(shaAsset.browser_download_url,5,agent,headers)).toString('utf8');sha256=(/^[0-9a-f]{64}/.exec(body.trim())||[])[0]||null}
 return {filename:name,url:asset.browser_download_url,sha256,archive:'tar.gz'}
}
function runFile(file,args){
 return new Promise((resolve,reject)=>{execFile(file,args,{windowsHide:true},error=>error?reject(error):resolve())})
}
async function extractZip(buffer,target){
 const temporary=path.join(os.tmpdir(),`0kay-toolchain-${crypto.randomUUID()}.zip`)
 await fs.writeFile(temporary,buffer)
 try{
  try{await runFile('tar',['-xf',temporary,'-C',target])}
  catch{
   const escaped=temporary.replace(/'/g,"''");const out=target.replace(/'/g,"''")
   await runFile('powershell',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${escaped}' -DestinationPath '${out}' -Force`])
  }
 }finally{await fs.rm(temporary,{force:true})}
 await flattenSingleRoot(target)
}
async function flattenSingleRoot(dir){
 const entries=await fs.readdir(dir,{withFileTypes:true})
 if(entries.length!==1||!entries[0].isDirectory())return
 const nested=path.join(dir,entries[0].name)
 for(const entry of await fs.readdir(nested))await fs.rename(path.join(nested,entry),path.join(dir,entry))
 await fs.rm(nested,{recursive:true,force:true})
}
async function downloadAndVerify(asset,log){
 log(`Downloading ${asset.filename}...`)
 const buffer=await downloadOnce(asset.url,5,asset.agent,asset.headers)
 if(process.env.OKAY_TOOLCHAIN_INSECURE!=='1'){
  if(!asset.sha256)throw new Error(`No checksum published for ${asset.filename}; set OKAY_TOOLCHAIN_INSECURE=1 to override`)
  const digest=crypto.createHash('sha256').update(buffer).digest('hex')
  if(digest!==asset.sha256.toLowerCase())throw new Error(`Checksum mismatch for ${asset.filename}`)
 }
 return buffer
}
const pending=new Map()
/**
 * Ensure a toolchain is available. Returns the absolute executable path, or
 * null when the tool is unknown, downloadable provisioning is disabled, or the
 * download fails (callers fall back to the system executable / a clear error).
 */
export async function ensureToolchain(executable,options={}){
 const tool=toolchainFor(executable)
 if(!tool)return null
 const info=platformInfo(options.platform,options.arch)
 const home=options.home||path.join(os.homedir(),'.0kay')
 let version=options.version||null
 if(!version&&tool==='go')version=await requiredGoVersion(options.cwd||'.')
 if(!version)version=DEFAULT_VERSIONS[tool]
 const dir=path.join(home,'toolchains',tool,version)
 const existing=executablePath(tool,dir,info.platform)
 if(existsSync(existing))return existing
 if(options.allowDownload===false)return null
 const key=`${tool}@${version}@${info.platform}/${info.arch}`
 if(pending.has(key))return pending.get(key)
 const log=options.log||console.log
 const task=(async()=>{
  const agent=options.agent||null
  let asset
  if(tool==='go')asset=await goAsset(version,info,agent)
  else if(tool==='node')asset=await nodeAsset(version,info,agent)
  else asset=await pythonAsset(version,info,agent)
  asset.agent=agent
  const buffer=await downloadAndVerify(asset,log)
  await fs.rm(dir,{recursive:true,force:true})
  await fs.mkdir(dir,{recursive:true})
  log(`Installing ${tool} ${version} into ${dir}...`)
  if(asset.archive==='zip')await extractZip(buffer,dir)
  else extractTarGz(buffer,dir,{links:true})
  if(!existsSync(executablePath(tool,dir,info.platform)))throw new Error(`Provisioned ${tool} ${version} is missing ${path.basename(existing)}`)
  return executablePath(tool,dir,info.platform)
 })()
 pending.set(key,task)
 try{return await task}finally{pending.delete(key)}
}
/** Every installed toolchain bin directory, newest tool first, for PATH. */
export async function toolchainBinDirs(home,platform=process.platform){
 const root=path.join(home||path.join(os.homedir(),'.0kay'),'toolchains')
 const dirs=[]
 for(const tool of ['go','node','python']){
  let versions=[]
  try{versions=await fs.readdir(path.join(root,tool))}catch{continue}
  for(const version of versions)for(const bin of binDirs(tool,path.join(root,tool,version),platform))if(existsSync(bin))dirs.push(bin)
 }
 return dirs
}
