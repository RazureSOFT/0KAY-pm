import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,writeFileSync} from 'node:fs'
import https from 'node:https'
import zlib from 'node:zlib'

export const packages={
 '@razuresoft/0kay':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'manifest.json'},
 '@razuresoft/0kay-agent':{repository:'https://github.com/RazureSOFT/0KAY-agent.git',manifest:'manifest.json'},
 '@razuresoft/0kay-core':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'core/manifest.json'},
 '@razuresoft/0kay-life':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'life/manifest.json'},
 '@razuresoft/0kay-mocr':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'mocr/manifest.json'},
 '@razuresoft/0kay-mcp':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'mcp/manifest.json'},
 '@razuresoft/0kay-webui':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'webui/manifest.json'},
 '@razuresoft/0kay-searxng':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'searxng/manifest.json'},
}
export function within(root,relative){const value=path.resolve(root,relative);if(value!==root&&!value.startsWith(root+path.sep))throw new Error('Manifest path escapes package');return value}
/** GitHub repository URL → source archive URL. Fetches archives, never git. tag null selects the branch. */
export function archiveUrl(repository,branch='main',tag=null){
 const match=/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repository)
 if(!match)throw new Error(`Unsupported repository URL: ${repository}`)
 const ref=tag?`refs/tags/${tag}`:`refs/heads/${branch}`
 return `https://github.com/${match[1]}/${match[2]}/archive/${ref}.tar.gz`
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
/** Extract a GitHub source tarball (single top-level directory) into target. */
export function extractTarGz(buffer,target){
 const tar=zlib.gunzipSync(buffer)
 const root=path.resolve(target);mkdirSync(root,{recursive:true})
 let offset=0,longName=null,paxPath=null
 while(offset+512<=tar.length){
  const header=tar.subarray(offset,offset+512)
  if(header.every(byte=>byte===0))break
  const name=tarString(header,0,100)
  const prefix=tarString(header,345,155)
  const size=parseInt(tarString(header,124,12).trim()||'0',8)||0
  const rawType=header[156]
  const type=rawType===0?'\0':String.fromCharCode(rawType)
  const mode=parseInt(tarString(header,100,8).trim()||'644',8)||0o644
  offset+=512
  const content=tar.subarray(offset,offset+size)
  offset+=Math.ceil(size/512)*512
  if(type==='x'||type==='g'){const records=parsePax(content);if(records.path)paxPath=records.path;continue}
  if(type==='L'){longName=content.toString('utf8').replace(/\0+$/,'');continue}
  if(type==='1'||type==='2'||type==='K')continue // symbolic/hard links are not part of these repositories
  let relative=paxPath||longName||(prefix?`${prefix}/${name}`:name)
  paxPath=null;longName=null
  const slash=relative.indexOf('/')
  if(slash<0)continue // top-level directory entry
  relative=relative.slice(slash+1)
  if(!relative)continue
  const destination=path.resolve(root,relative)
  if(!destination.startsWith(root+path.sep))throw new Error(`Archive path escapes package: ${relative}`)
  if(type==='5'||relative.endsWith('/')){mkdirSync(destination,{recursive:true});continue}
  mkdirSync(path.dirname(destination),{recursive:true})
  writeFileSync(destination,content,{mode:mode&0o777})
 }
}
/** One HTTPS GET with redirect following; resolves the full body buffer. */
function downloadOnce(url,redirects=5){
 return new Promise((resolve,reject)=>{
  if(redirects<0){reject(new Error(`Too many redirects: ${url}`));return}
  const request=https.get(url,{timeout:120000},response=>{
   const status=response.statusCode||0
   if(status>=300&&status<400&&response.headers.location){
    response.resume()
    downloadOnce(new URL(response.headers.location,url).toString(),redirects-1).then(resolve,reject)
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
/** Download a repository source archive and extract it into target (proxy aware, retried). */
export async function downloadArchive(repository,target,options={}){
 const archive=archiveUrl(repository,'main',options.tag||null)
 const url=options.proxy?`https://gh-proxy.com/${archive}`:archive
 let lastError
 for(let attempt=1;attempt<=3;attempt++){
  try{
   const buffer=await downloadOnce(url)
   await fs.rm(target,{recursive:true,force:true})
   extractTarGz(buffer,target)
   return
  }catch(error){
   lastError=error
   if(attempt<3)await new Promise(resolve=>setTimeout(resolve,attempt*2000))
  }
 }
 throw lastError
}
export function validateManifest(value){
 if(value.schema!==1||typeof value.name!=='string'||!/^@razuresoft\/[a-z0-9-]+$/.test(value.name)||typeof value.version!=='string')throw new Error('Invalid manifest identity/schema')
 for(const command of [...(value.install||[]),...(value.start?[value.start]:[]),...(value.ui?.build||[])])if(!Array.isArray(command)||!command.length||command.some(arg=>typeof arg!=='string'||/[\r\n\0]/.test(arg)))throw new Error('Manifest commands must be argument arrays')
 if(value.ui!=null){
  if(typeof value.ui!=='object'||value.ui===null||Array.isArray(value.ui))throw new Error('Manifest ui must be an object')
  if(value.ui.dir!=null&&(typeof value.ui.dir!=='string'||/[\r\n\0]/.test(value.ui.dir)))throw new Error('Manifest ui.dir must be a path string')
  if(value.ui.plugin!=null&&(!/^[A-Za-z0-9_-]{1,64}$/.test(value.ui.plugin)))throw new Error('Manifest ui.plugin is invalid')
  if(value.ui.dist!=null&&(typeof value.ui.dist!=='string'||/[\r\n\0]/.test(value.ui.dist)))throw new Error('Manifest ui.dist must be a path string')
  if(value.ui.build!=null&&!Array.isArray(value.ui.build))throw new Error('Manifest ui.build must be argv arrays')
 }
 return value
}
/** Copy a built plugin UI bundle into CORE_DATA_DIR/plugin-ui/{name} (atomic replace). */
export async function publishPluginUI(sourceDir,pluginName,dataDir){
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(pluginName))throw new Error('Invalid plugin-ui name')
 const root=path.resolve(dataDir||process.env.CORE_DATA_DIR||'data')
 const dest=path.join(root,'plugin-ui',pluginName)
 const staging=dest+'.install-'+randomUUID()
 await fs.mkdir(path.dirname(dest),{recursive:true})
 await fs.cp(sourceDir,staging,{recursive:true})
 await fs.rm(dest,{recursive:true,force:true})
 await fs.rename(staging,dest)
 return dest
}
/** Run a manifest's ui.build commands and publish its dist directory. */
async function publishManifestUI(manifest,manifestDir,options){
 const uiRoot=within(manifestDir,manifest.ui.dir||'.')
 for(const command of manifest.ui.build||[])await run(command,uiRoot)
 const dist=path.resolve(uiRoot,manifest.ui.dist||'dist')
 if(!await fs.stat(dist).then(()=>true,()=>false))throw new Error(`Plugin UI dist missing: ${dist}`)
 const pluginName=manifest.ui.plugin||manifest.name.split('/')[1]
 await publishPluginUI(dist,pluginName,options.coreData)
}
export function run(command,cwd,env={}){return new Promise((resolve,reject)=>{
 let [executable,...args]=command
 // npm.cmd needs a shell on Windows; manifest arguments cannot inject shell operators.
 let shell=process.platform==='win32'&&['npm','npx'].includes(executable)
 if(shell){const cli=path.join(path.dirname(process.execPath),'node_modules','npm','bin',`${executable}-cli.js`);if(existsSync(cli)){args=[cli,...args];executable=process.execPath;shell=false}}
 if(shell&&args.some(arg=>/[&|<>^]/.test(arg)))throw new Error('Unsupported shell operator in npm arguments')
 const child=spawn(executable,args,{cwd,env:{...process.env,...env},stdio:'inherit',shell})
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${executable} exited ${code}`)))
})}
export async function installPackage(name,options,state,stack=[]) {
 if(stack.includes(name))throw new Error(`Dependency cycle: ${[...stack,name].join(' -> ')}`)
 if(state.installed[name]&&!options.reinstall)return state.installed[name]
 const spec=packages[name];if(!spec)throw new Error(`Unknown package ${name}`)
 const destination=path.join(options.home,'packages',name.split('/')[1]);await fs.mkdir(path.dirname(destination),{recursive:true})
 if(!options.reinstall&&await fs.stat(destination).then(()=>true,()=>false))throw new Error(`Destination already exists: ${destination}; existing work is never overwritten`)
 const staging=destination+'.install-'+randomUUID();await fs.mkdir(staging,{recursive:true})
 try {
  if(options.source) await fs.cp(path.resolve(options.source),staging,{recursive:true,filter:source=>!['.git','node_modules','dist','data','__pycache__'].includes(path.basename(source))&&!source.endsWith('.log')&&!source.endsWith('.exe')})
   else {
    await downloadArchive(spec.repository,staging,options)
   }
  const manifestPath=within(staging,spec.manifest)
  const manifest=validateManifest(JSON.parse(await fs.readFile(manifestPath,'utf8')))
  if(manifest.name!==name)throw new Error('Package identity does not match requested package')
  for(const repository of manifest.repositories||[]) {
   const target=within(staging,repository.path)
   if(!await fs.stat(path.join(target,'manifest.json')).then(()=>true,()=>false)){
     const spec=packages[repository.package];if(!spec||spec.repository!==repository.url)throw new Error('Unrecognized module repository')
      await downloadArchive(repository.url,target,options)
   }
  }
  // A child manifest supplies build commands and cwd; repository layout stays intact.
  for(const dependency of manifest.dependencies||[]){
   const siblingSource=options.source&&dependency==='@razuresoft/0kay-mcp'?path.resolve(options.source,'..'):null
   await installPackage(dependency,{...options,source:siblingSource},state,[...stack,name])
  }
   for(const child of manifest.modules||[]) {
    const childPath=within(staging,child)
    const module=validateManifest(JSON.parse(await fs.readFile(childPath,'utf8')))
    for(const command of module.install||[])await run(command,path.dirname(childPath))
    if(module.ui)await publishManifestUI(module,path.dirname(childPath),options)
   }
  if(name==='@razuresoft/0kay-agent') {
   const mcp=state.installed['@razuresoft/0kay-mcp'];if(!mcp)throw new Error('MCP dependency missing')
   // Agent expects sibling mcp and proto. Keep them within its installed package.
   await fs.cp(mcp.repositoryRoot,staging+'/platform',{recursive:true,filter:source=>!['.git','node_modules','data'].includes(path.basename(source))})
   await fs.mkdir(path.join(staging,'agent'),{recursive:true})
   for(const entry of await fs.readdir(staging)){if(entry==='platform'||entry==='agent')continue;await fs.rename(path.join(staging,entry),path.join(staging,'agent',entry))}
   await fs.rename(path.join(staging,'platform','mcp'),path.join(staging,'mcp'))
   await fs.rename(path.join(staging,'platform','proto'),path.join(staging,'proto'))
   await run(['npm','ci'],path.join(staging,'mcp'));await run(['npm','run','build'],path.join(staging,'mcp'))
  }
const cwd=name==='@razuresoft/0kay-agent'?path.join(staging,'agent'):path.dirname(manifestPath)
   for(const command of manifest.install||[])await run(command,cwd)
   if(manifest.ui)await publishManifestUI(manifest,path.dirname(manifestPath),options)
    // Preserve runtime data before replacing an installation. Newly built plugin
    // bundles take precedence over old bundles inside core/data/plugin-ui.
    if(await fs.stat(destination).then(()=>true,()=>false)){
     for(const relative of ['data','core/data','life/data','agent/data','mocr/data']){
      const source=path.join(destination,relative)
      if(await fs.stat(source).then(()=>true,()=>false))await fs.cp(source,path.join(staging,relative),{recursive:true,force:false,errorOnExist:false})
     }
    const previousEnv=await fs.readFile(path.join(destination,'runtime-env.json'),'utf8').catch(()=>null)
    const backup=destination+'.old-'+randomUUID()
    await fs.rename(destination,backup)
    try{
     if(previousEnv!=null)await fs.writeFile(path.join(staging,'runtime-env.json'),previousEnv,{mode:0o600})
     await fs.rename(staging,destination)
    }catch(error){
     await fs.rm(destination,{recursive:true,force:true}).catch(()=>{})
      await fs.rename(backup,destination)
      throw error
     }
     // Keep the previous tree as a recovery copy, including unlisted user files.
   }else await fs.rename(staging,destination)
   const record={name,version:manifest.version,repository:spec.repository,repositoryRoot:destination,cwd:path.join(destination,path.relative(staging,cwd)),start:manifest.start||null,modules:manifest.modules||[],installed_at:new Date().toISOString()}
  // Editable Python installs embed absolute paths. Rebind after atomic promotion.
  if(name==='@razuresoft/0kay-life')await run(['python','-m','pip','install','-e','.'],record.cwd)
  if(name==='@razuresoft/0kay'&&(manifest.modules||[]).includes('life/manifest.json'))await run(['python','-m','pip','install','-e','.'],path.join(destination,'life'))
  state.installed[name]=record;return record
 }catch(error){await fs.rm(staging,{recursive:true,force:true});throw error}
}
