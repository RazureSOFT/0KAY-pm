import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {installPackage,uninstallPackage,publishPluginUI,run} from '../src/installer.mjs'
test('local install executes manifest and rejects overwrite',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-test-'))
 try{
  const source=path.join(root,'source');await fs.mkdir(source)
  await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({schema:1,name:'@razuresoft/0kay',version:'test',install:[[process.execPath,'-e',"require('fs').writeFileSync('built.txt','ok')"]]}))
  const state={installed:{}};const record=await installPackage('@razuresoft/0kay',{home:path.join(root,'home'),source},state)
  assert.equal(await fs.readFile(path.join(record.repositoryRoot,'built.txt'),'utf8'),'ok')
  assert.equal((await installPackage('@razuresoft/0kay',{home:path.join(root,'home'),source},state)).version,'test')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('publishPluginUI copies dist into plugin-ui atomically',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-ui-'))
 try{
  const dist=path.join(root,'dist');await fs.mkdir(path.join(dist,'assets'),{recursive:true})
  await fs.writeFile(path.join(dist,'index.js'),'export default {}')
  await fs.writeFile(path.join(dist,'assets','chunk-abc.js'),'//hash')
  const data=path.join(root,'data')
  const dest=await publishPluginUI(dist,'demo',data)
  assert.equal(dest,path.join(data,'plugin-ui','demo'))
  assert.ok((await fs.readFile(path.join(dest,'index.js'),'utf8')).includes('export default'))
  assert.ok((await fs.stat(path.join(dest,'assets','chunk-abc.js'))).isFile())
  await assert.rejects(()=>publishPluginUI(dist,'../evil',data))
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('install with ui.build publishes plugin-ui',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-uibuild-'))
 try{
  const source=path.join(root,'source');await fs.mkdir(source)
  await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({
   schema:1,name:'@razuresoft/0kay',version:'test',install:[],
   ui:{dir:'.',plugin:'demo',dist:'dist',build:[[process.execPath,'-e',"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','ok')"]]},
  }))
  const data=path.join(root,'data')
  const state={installed:{}}
  await installPackage('@razuresoft/0kay',{home:path.join(root,'home'),source,coreData:data},state)
  const published=path.join(data,'plugin-ui','demo','index.html')
  assert.match(await fs.readFile(published,'utf8'),/ok/)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('reinstall replaces the package, keeps runtime-env, and republishes module UIs',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-reinstall-'))
 try{
  const source=path.join(root,'source');await fs.mkdir(path.join(source,'child'),{recursive:true})
  const writeManifest=version=>fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({
   schema:1,name:'@razuresoft/0kay',version,install:[],
   modules:['child/manifest.json'],
  }))
  await writeManifest('1.0.0')
  await fs.writeFile(path.join(source,'child','manifest.json'),JSON.stringify({
   schema:1,name:'@razuresoft/0kay-child',version:'1.0.0',install:[],
   ui:{dir:'.',plugin:'kid',dist:'dist',build:[[process.execPath,'-e',"const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/index.js','v1')"]]},
  }))
  const home=path.join(root,'home');const data=path.join(root,'data');const state={installed:{}}
  const first=await installPackage('@razuresoft/0kay',{home,source,coreData:data},state)
  assert.equal(first.version,'1.0.0')
  assert.equal(await fs.readFile(path.join(data,'plugin-ui','kid','index.js'),'utf8'),'v1')
  await fs.writeFile(path.join(first.repositoryRoot,'runtime-env.json'),'{"CORE_HTTP_PORT":"18080"}',{mode:0o600})
  await fs.mkdir(path.join(first.repositoryRoot,'core','data'),{recursive:true})
  await fs.writeFile(path.join(first.repositoryRoot,'core','data','settings.json'),'preserve-me')
  await writeManifest('2.0.0')
  await fs.writeFile(path.join(source,'child','manifest.json'),JSON.stringify({
   schema:1,name:'@razuresoft/0kay-child',version:'2.0.0',install:[],
   ui:{dir:'.',plugin:'kid',dist:'dist',build:[[process.execPath,'-e',"const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/index.js','v2')"]]},
  }))
  const second=await installPackage('@razuresoft/0kay',{home,source,coreData:data,reinstall:true},state)
  assert.equal(second.version,'2.0.0')
  assert.equal(await fs.readFile(path.join(second.repositoryRoot,'runtime-env.json'),'utf8'),'{"CORE_HTTP_PORT":"18080"}')
  assert.equal(await fs.readFile(path.join(data,'plugin-ui','kid','index.js'),'utf8'),'v2')
  assert.equal(await fs.readFile(path.join(second.repositoryRoot,'core','data','settings.json'),'utf8'),'preserve-me')
  const entries=await fs.readdir(path.join(home,'packages'))
  assert.equal(entries.filter(entry=>entry.includes('.old-')).length,1,'previous installation retained for recovery')
  assert.equal(entries.filter(entry=>entry.includes('.install-')).length,0,'no staging directories remain')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('install recovers a leftover package directory from an interrupted run',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-leftover-'))
 try{
  const source=path.join(root,'source');await fs.mkdir(source)
  await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({schema:1,name:'@razuresoft/0kay',version:'2.0.0',install:[]}))
  const home=path.join(root,'home');const leftover=path.join(home,'packages','0kay')
  await fs.mkdir(leftover,{recursive:true})
  await fs.writeFile(path.join(leftover,'stale.txt'),'old')
  const state={installed:{}}
  const record=await installPackage('@razuresoft/0kay',{home,source},state)
  assert.equal(record.version,'2.0.0')
  assert.equal(await fs.stat(path.join(record.repositoryRoot,'stale.txt')).then(()=>true,()=>false),false)
  const entries=await fs.readdir(path.join(home,'packages'))
  assert.ok(entries.some(entry=>entry.includes('.old-')),'leftover kept as a recovery copy')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('source install publishes manifest patches and skips root runtime data',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-patch-'))
 try{
  const source=path.join(root,'source')
  await fs.mkdir(path.join(source,'core','data','ui'),{recursive:true})
  await fs.writeFile(path.join(source,'core','data','ui','demo.patch'),'{"id":"demo"}')
  await fs.mkdir(path.join(source,'data'),{recursive:true})
  await fs.writeFile(path.join(source,'data','runtime.db'),'runtime')
  await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({schema:1,name:'@razuresoft/0kay',version:'1.0.0',install:[],patches:['core/data/ui/demo.patch']}))
  const home=path.join(root,'home');const coreData=path.join(root,'coreData');const state={installed:{}}
  const record=await installPackage('@razuresoft/0kay',{home,source,coreData},state)
  assert.equal(await fs.readFile(path.join(coreData,'ui','demo.patch'),'utf8'),'{"id":"demo"}')
  assert.equal(await fs.stat(path.join(record.repositoryRoot,'data','runtime.db')).then(()=>true,()=>false),false,'root runtime data excluded')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('uninstall removes the package, plugin-ui and patches',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-remove-'))
 try{
  const source=path.join(root,'source')
  await fs.mkdir(path.join(source,'core','data','ui'),{recursive:true})
  await fs.writeFile(path.join(source,'core','data','ui','demo.patch'),'{"id":"demo"}')
  await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({
   schema:1,name:'@razuresoft/0kay-demo',version:'1.0.0',install:[],patches:['core/data/ui/demo.patch'],
   ui:{dir:'.',plugin:'demo',dist:'dist',build:[[process.execPath,'-e',"const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/index.js','ok')"]]},
  }))
  const home=path.join(root,'home');const coreData=path.join(root,'coreData');const state={installed:{}}
  const record=await installPackage('@razuresoft/0kay-demo',{home,source,coreData},state)
  assert.ok(await fs.stat(path.join(coreData,'plugin-ui','demo','index.js')).then(()=>true,()=>false))
  assert.ok(await fs.stat(path.join(coreData,'ui','demo.patch')).then(()=>true,()=>false))
  const result=await uninstallPackage('@razuresoft/0kay-demo',{home,coreData},state)
  assert.equal(result.removedTree,true)
  assert.equal(await fs.stat(path.join(coreData,'plugin-ui','demo')).then(()=>true,()=>false),false)
  assert.equal(await fs.stat(path.join(coreData,'ui','demo.patch')).then(()=>true,()=>false),false)
  assert.equal(await fs.stat(record.repositoryRoot).then(()=>true,()=>false),false)
  assert.equal(state.installed['@razuresoft/0kay-demo'],undefined)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('uninstall keeps a source tree outside the packages directory',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-keep-'))
 try{
  const source=path.join(root,'source');await fs.mkdir(source)
  await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify({schema:1,name:'@razuresoft/0kay-source',version:'1.0.0',install:[]}))
  const home=path.join(root,'home');const coreData=path.join(root,'coreData');const state={installed:{}}
  const record=await installPackage('@razuresoft/0kay-source',{home,source,coreData},state)
  state.installed['@razuresoft/0kay-source'].repositoryRoot=source
  const result=await uninstallPackage('@razuresoft/0kay-source',{home,coreData},state)
  assert.equal(result.removedTree,false)
  assert.ok(await fs.stat(source).then(()=>true,()=>false),'source tree preserved')
  assert.equal(state.installed['@razuresoft/0kay-source'],undefined)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('run reports a missing executable clearly',async()=>{
 await assert.rejects(()=>run(['definitely-missing-command-0kay'],process.cwd()),/Required command not found: definitely-missing-command-0kay/)
})
