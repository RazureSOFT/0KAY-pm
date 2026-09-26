import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {downloadOnce,proxyAgentFor,extractTarGz} from './download.mjs'
import {ensureToolchain,isKnownToolchain,toolchainBinDirs} from './toolchain.mjs'

export {resolveProxy,extractTarGz,proxyAgentFor,downloadOnce} from './download.mjs'

export const packages={
 '@razuresoft/0kay':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'manifest.json'},
 '@razuresoft/0kay-agent':{repository:'https://github.com/RazureSOFT/0KAY-agent.git',manifest:'manifest.json'},
 '@razuresoft/0kay-core':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'core/manifest.json'},
 '@razuresoft/0kay-life':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'life/manifest.json'},
 '@razuresoft/0kay-mocr':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'mocr/manifest.json'},
 '@razuresoft/0kay-mcp':{repository:'https://github.com/RazureSOFT/0KAY-mcp.git',manifest:'manifest.json'},
 '@razuresoft/0kay-webui':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'webui/manifest.json'},
 '@razuresoft/0kay-searxng':{repository:'https://github.com/RazureSOFT/0KAY.git',manifest:'searxng/manifest.json'},
}
/** npm registry used to resolve third-party packages (override with OKAY_NPM_REGISTRY). */
const REGISTRY=process.env.OKAY_NPM_REGISTRY||'https://registry.npmjs.org'
/** Normalize a package.json `repository` value to a GitHub https URL. */
export function normalizeRepository(value){
 const raw=typeof value==='string'?value:value&&value.url
 if(!raw)return null
 const url=String(raw).replace(/^git\+/,'').replace(/^git:\/\//,'https://').replace(/^ssh:\/\/git@/,'https://').replace(/^git@github\.com:/,'https://github.com/')
 const match=/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
 return match?`https://github.com/${match[1]}/${match[2]}.git`:null
}
/**
 * Resolve a package name to {repository, manifest}. First-party names use the
 * built-in map. Other names resolve through the npm registry (`repository`
 * field), then fall back to a GitHub `owner/repo` convention. `owner/repo`
 * input (unscoped) is accepted directly.
 */
export async function resolveSpec(name){
 if(packages[name])return packages[name]
 if(name.includes('/')&&!name.startsWith('@'))return {repository:`https://github.com/${name}.git`,manifest:'manifest.json'}
 try{
  const response=await fetch(`${REGISTRY}/${name}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)})
  if(response.ok){const data=await response.json();const repository=normalizeRepository(data.repository);if(repository)return {repository,manifest:'manifest.json'}}
 }catch{ /* offline or unpublished → fall back to the GitHub convention */ }
 const ownerRepo=name.replace(/^@/,'')
 if(/^[^/]+\/[^/]+$/.test(ownerRepo))return {repository:`https://github.com/${ownerRepo}.git`,manifest:'manifest.json'}
 return null
}
/** Installation folder name (scope-aware; repository specs use the repo short name). */
function packageFolder(name,repoSpec){
 const trimmed=repoSpec?name.replace(/^https?:\/\/github\.com\//,'').replace(/^git@github\.com:/,'').replace(/\.git$/,'').replace(/^@/,''):name.replace(/^@/,'')
 if(!repoSpec)return name.startsWith('@razuresoft/')?name.split('/')[1]:trimmed.replace(/\//g,'-')
 return trimmed.split('/').pop()||'package'
}
export function within(root,relative){const value=path.resolve(root,relative);if(value!==root&&!value.startsWith(root+path.sep))throw new Error('Manifest path escapes package');return value}
/** GitHub repository URL → source archive URL. Fetches archives, never git. tag null selects the branch. */
export function archiveUrl(repository,branch='main',tag=null){
 const match=/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repository)
 if(!match)throw new Error(`Unsupported repository URL: ${repository}`)
 const ref=tag?`refs/tags/${tag}`:`refs/heads/${branch}`
 return `https://github.com/${match[1]}/${match[2]}/archive/${ref}.tar.gz`
}
/** Download a repository source archive and extract it into target (proxy aware, retried). */
export async function downloadArchive(repository,target,options={}){
 const archive=archiveUrl(repository,'main',options.tag||null)
 // codeload serves the same tarball and survives networks where github.com is
 // blocked; retry it when the canonical archive host is unreachable.
 const fallback=archive.replace('https://github.com/','https://codeload.github.com/').replace('/archive/','/tar.gz/').replace(/\.tar\.gz$/,'')
 const agent=proxyAgentFor(options)
 let lastError
 for(const candidate of [archive,fallback]){
  const url=options.proxy?`https://gh-proxy.com/${candidate}`:candidate
  for(let attempt=1;attempt<=2;attempt++){
   try{
    const buffer=await downloadOnce(url,5,agent)
    await fs.rm(target,{recursive:true,force:true})
    extractTarGz(buffer,target)
    return
   }catch(error){
    lastError=error
    if(attempt<2)await new Promise(resolve=>setTimeout(resolve,attempt*2000))
   }
  }
 }
 throw lastError
}
export function validateManifest(value){
 if(value.schema!==1||typeof value.name!=='string'||!/^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/.test(value.name)||typeof value.version!=='string')throw new Error('Invalid manifest identity/schema')
 for(const command of [...(value.install||[]),...(value.start?[value.start]:[]),...(value.ui?.build||[])])if(!Array.isArray(command)||!command.length||command.some(arg=>typeof arg!=='string'||/[\r\n\0]/.test(arg)))throw new Error('Manifest commands must be argument arrays')
 if(value.patches!=null&&(!Array.isArray(value.patches)||value.patches.some(entry=>typeof entry!=='string'||/[\r\n\0]/.test(entry))))throw new Error('Manifest patches must be path strings')
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
/** Copy a manifest's UI patch files into CORE_DATA_DIR/ui/ so Core picks them up. */
async function installManifestPatches(manifest,staging,options){
 if(!manifest.patches||!manifest.patches.length)return
 const root=path.resolve(options.coreData||process.env.CORE_DATA_DIR||'data')
 const uiDir=path.join(root,'ui');await fs.mkdir(uiDir,{recursive:true})
 for(const relative of manifest.patches){
  const source=within(staging,relative)
  if(!await fs.stat(source).then(()=>true,()=>false))throw new Error(`Manifest patch missing: ${relative}`)
  await fs.copyFile(source,path.join(uiDir,path.basename(relative)))
 }
}
/** Locate an executable on PATH (or as a relative path) before spawning it. */
function findExecutable(name,cwd,extraDirs=[]){
 if(name.includes('/')||name.includes('\\')){const candidate=path.resolve(cwd||'.',name);return existsSync(candidate)?candidate:null}
 const extensions=process.platform==='win32'?(process.env.PATHEXT||'.EXE;.CMD;.BAT').split(';').filter(Boolean):['']
 const directories=[...(process.env.PATH||'').split(path.delimiter).filter(Boolean),...extraDirs]
 for(const directory of directories){
  for(const extension of extensions){const candidate=path.join(directory,name+extension);if(existsSync(candidate))return candidate}
 }
 return null
}
/** python/python3 naming differs across platforms; try the sibling name. */
const EXECUTABLE_FALLBACKS={python:['python3'],python3:['python']}
/**
 * Toolchain config shared by run(): where user-level toolchains live, whether
 * downloading them is allowed, the proxy/agent used for downloads, and an
 * optional proxy to forward to build commands (go/pip/npm).
 */
let toolchainConfig={home:null,allowDownload:true,agent:null,log:null,proxy:null}
export function configureToolchains(options={}){toolchainConfig={...toolchainConfig,...options}}
let cachedBinDirs=null
async function toolchainPathDirs(){
 if(!toolchainConfig.home)return []
 if(!cachedBinDirs)cachedBinDirs=await toolchainBinDirs(toolchainConfig.home)
 return cachedBinDirs
}
export async function run(command,cwd,env={}){
 let [executable,...args]=command
 // npm.cmd needs a shell on Windows; manifest arguments cannot inject shell operators.
 let shell=process.platform==='win32'&&['npm','npx'].includes(executable)
 if(shell){const cli=path.join(path.dirname(process.execPath),'node_modules','npm','bin',`${executable}-cli.js`);if(existsSync(cli)){args=[cli,...args];executable=process.execPath;shell=false}}
 if(shell&&args.some(arg=>/[&|<>^]/.test(arg)))throw new Error('Unsupported shell operator in npm arguments')
 if(!shell){
  let found=findExecutable(executable,cwd)
  if(!found&&isKnownToolchain(executable)){
   found=await ensureToolchain(executable,{home:toolchainConfig.home,cwd,allowDownload:toolchainConfig.allowDownload,agent:toolchainConfig.agent,log:toolchainConfig.log||console.log})
  }
  if(!found)for(const fallback of EXECUTABLE_FALLBACKS[executable]||[]){if(findExecutable(fallback,cwd)){executable=fallback;found=true;break}}
  if(!found){throw new Error(`Required command not found: ${executable}. Install it and add it to PATH, then retry.`)}
  if(path.isAbsolute(found)&&found!==executable)executable=found
 }
 const extraDirs=await toolchainPathDirs()
 const pathValue=[...extraDirs,...String(env.PATH??process.env.PATH??'').split(path.delimiter).filter(Boolean)].join(path.delimiter)
 // Forward an explicit proxy so module fetches (go proxy.golang.org, pip, npm)
 // reuse the same tunnel as the archive download.
 const proxyEnv={}
 if(toolchainConfig.proxy){proxyEnv.HTTPS_PROXY=toolchainConfig.proxy;proxyEnv.HTTP_PROXY=toolchainConfig.proxy;proxyEnv.ALL_PROXY=toolchainConfig.proxy;if(process.env.NO_PROXY)proxyEnv.NO_PROXY=process.env.NO_PROXY}
 const child=spawn(executable,args,{cwd,env:{...process.env,...proxyEnv,...env,PATH:pathValue,GOTOOLCHAIN:process.env.GOTOOLCHAIN||'auto'},stdio:'inherit',shell})
 return await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${executable} exited ${code}`)))})
}
/** Resolve a manifest command to absolute paths (for a service unit; no download). */
export async function resolveCommand(command,cwd,home){
 let [executable,...args]=command
 if(executable.includes('/')||executable.includes('\\')){
  executable=path.resolve(cwd||'.',executable)
 }else{
  const extra=home?await toolchainBinDirs(home):[]
  let resolved=findExecutable(executable,cwd,extra)
  if(!resolved)for(const fallback of EXECUTABLE_FALLBACKS[executable]||[]){const candidate=findExecutable(fallback,cwd,extra);if(candidate){resolved=candidate;break}}
  if(resolved)executable=resolved
 }
 return [executable,...args]
}
export async function installPackage(name,options,state,stack=[]) {
 if(stack.includes(name))throw new Error(`Dependency cycle: ${[...stack,name].join(' -> ')}`)
 // `owner/repo` or a repository URL installs whatever the manifest declares.
 const repoSpec=/^(https?:\/\/|git@)/.test(name)||(name.includes('/')&&!name.startsWith('@'))
 if(!repoSpec&&state.installed[name]&&!options.reinstall)return state.installed[name]
 const spec=options.source?(packages[name]||{repository:null,manifest:'manifest.json'}):await resolveSpec(name)
 if(!spec)throw new Error(`Unknown package ${name}`)
 // Reuse the folder of an existing installation so updates never orphan the
 // package's runtime-env.json/data when the name form changes (a scoped npm
 // name and its owner/repo form slug differently but are the same package).
 const previousRoot=state&&state.installed&&state.installed[name]?state.installed[name].repositoryRoot:null
 const folder=previousRoot?path.basename(previousRoot):packageFolder(name,repoSpec)
 const destination=path.join(options.home,'packages',folder);await fs.mkdir(path.dirname(destination),{recursive:true})
 // A leftover directory without a state record means a previous install was
 // interrupted; it is replaced below like an update, keeping data and env.
 const staging=destination+'.install-'+randomUUID();await fs.mkdir(staging,{recursive:true})
 try {
  if(options.source){const sourceRoot=path.resolve(options.source);await fs.cp(sourceRoot,staging,{recursive:true,filter:source=>{
    const relative=path.relative(sourceRoot,source)
    if(!relative)return true
    const base=path.basename(source)
    // Build/runtime junk is never source. `data` is only skipped at the package
    // root; nested paths such as core/data/ui patches ship with the package.
    if(['.git','node_modules','__pycache__','dist'].includes(base))return false
    if(base==='data'&&!relative.includes(path.sep))return false
    return !source.endsWith('.log')&&!source.endsWith('.exe')
   }})}
   else {
    await downloadArchive(spec.repository,staging,options)
   }
  const manifestPath=within(staging,spec.manifest)
  const manifest=validateManifest(JSON.parse(await fs.readFile(manifestPath,'utf8')))
  // A repository spec installs the package under the name the manifest declares.
  const effectiveName=repoSpec?manifest.name:name
  if(manifest.name!==effectiveName)throw new Error('Package identity does not match requested package')
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
  if(effectiveName==='@razuresoft/0kay-agent') {
   const mcp=state.installed['@razuresoft/0kay-mcp'];if(!mcp)throw new Error('MCP dependency missing')
   // Agent expects sibling mcp and proto. Keep them within its installed package.
   await fs.cp(mcp.repositoryRoot,staging+'/platform',{recursive:true,filter:source=>!['.git','node_modules','data'].includes(path.basename(source))})
   await fs.mkdir(path.join(staging,'agent'),{recursive:true})
   for(const entry of await fs.readdir(staging)){if(entry==='platform'||entry==='agent')continue;await fs.rename(path.join(staging,entry),path.join(staging,'agent',entry))}
   // The KAY-mcp repository keeps the package at its root and proto/ alongside it.
   const platform=path.join(staging,'platform');await fs.mkdir(path.join(staging,'mcp'),{recursive:true})
   for(const entry of await fs.readdir(platform)){if(entry==='proto')continue;await fs.rename(path.join(platform,entry),path.join(staging,'mcp',entry))}
   await fs.rename(path.join(platform,'proto'),path.join(staging,'proto'))
   await fs.rm(platform,{recursive:true,force:true})
   await run(['npm','ci'],path.join(staging,'mcp'));await run(['npm','run','build'],path.join(staging,'mcp'))
  }
const cwd=effectiveName==='@razuresoft/0kay-agent'?path.join(staging,'agent'):path.dirname(manifestPath)
   for(const command of manifest.install||[])await run(command,cwd)
   if(manifest.ui)await publishManifestUI(manifest,path.dirname(manifestPath),options)
   await installManifestPatches(manifest,staging,options)
    // Preserve runtime data before replacing an installation. Newly built plugin
    // bundles take precedence over old bundles inside core/data/plugin-ui.
    if(await fs.stat(destination).then(()=>true,()=>false)){
     for(const relative of ['data','core/data','life/data','agent/data','mocr/data']){
      const source=path.join(destination,relative)
      if(await fs.stat(source).then(()=>true,()=>false))await fs.cp(source,path.join(staging,relative),{recursive:true,force:false,errorOnExist:false})
     }
    const envRoots=[destination,state&&state.installed&&state.installed[effectiveName]?state.installed[effectiveName].repositoryRoot:null].filter(Boolean)
    let previousEnv=null
    for(const root of envRoots){previousEnv=await fs.readFile(path.join(root,'runtime-env.json'),'utf8').catch(()=>null);if(previousEnv!=null)break}
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
   const record={name:effectiveName,version:manifest.version,repository:spec.repository||manifest.repository||null,repositoryRoot:destination,cwd:path.join(destination,path.relative(staging,cwd)),start:manifest.start||null,modules:manifest.modules||[],installed_at:new Date().toISOString()}
  // Editable Python installs embed absolute paths. Rebind after atomic promotion.
  if(effectiveName==='@razuresoft/0kay-life')await run(['python','-m','pip','install','-e','.'],record.cwd)
  if(effectiveName==='@razuresoft/0kay'&&(manifest.modules||[]).includes('life/manifest.json'))await run(['python','-m','pip','install','-e','.'],path.join(destination,'life'))
  state.installed[effectiveName]=record;return record
  }catch(error){await fs.rm(staging,{recursive:true,force:true});throw error}
}
/**
 * Remove a 0kay-pm installation: unpublish its UI bundle and patches, then drop
 * the package directory (only when 0kay-pm created it; a source checkout stays).
 * Caller is responsible for stopping services and saving state.
 */
export async function uninstallPackage(name,options,state){
 const record=state.installed[name];if(!record)throw new Error(`${name} is not installed`)
 const dataRoot=path.resolve(options.coreData||process.env.CORE_DATA_DIR||'data')
 const removed=[]
 try{
  const manifest=validateManifest(JSON.parse(await fs.readFile(path.join(record.repositoryRoot,'manifest.json'),'utf8')))
  if(manifest.ui){const plugin=manifest.ui.plugin||manifest.name.split('/')[1];await fs.rm(path.join(dataRoot,'plugin-ui',plugin),{recursive:true,force:true});removed.push(`plugin-ui/${plugin}`)}
  for(const relative of manifest.patches||[]){const file=path.basename(relative);await fs.rm(path.join(dataRoot,'ui',file),{force:true});removed.push(`ui/${file}`)}
 }catch{/* manifest gone; nothing to unpublish */}
 const packagesRoot=path.join(options.home,'packages')
 const root=path.resolve(record.repositoryRoot)
 const removedTree=root.startsWith(packagesRoot+path.sep)
 if(removedTree)await fs.rm(root,{recursive:true,force:true})
 delete state.installed[name]
 return {name,removed,removedTree}
}
