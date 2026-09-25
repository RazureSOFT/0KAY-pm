import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import {archiveUrl,extractTarGz,resolveProxy} from '../src/installer.mjs'

function header(name,size,type,mode='0000644'){
 const buffer=Buffer.alloc(512)
 buffer.write(name.slice(0,100),0,'utf8')
 buffer.write(mode,100,8,'ascii')
 buffer.write('0000000',108,8,'ascii')
 buffer.write('0000000',116,8,'ascii')
 buffer.write(size.toString(8).padStart(11,'0')+' ',124,12,'ascii')
 buffer.write('00000000000 ',136,12,'ascii')
 buffer.write('        ',148,8,'ascii')
 buffer.write(type,156,1,'ascii')
 buffer.write('ustar',257,5,'ascii')
 buffer.write('00',263,2,'ascii')
 let sum=0
 for(const byte of buffer)sum+=byte
 buffer.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii')
 return buffer
}
function entry(name,data,type='0'){
 const content=Buffer.from(data)
 const padding=Buffer.alloc((512-content.length%512)%512)
 return Buffer.concat([header(name,content.length,type),content,padding])
}
function paxEntry(records){
 let content=Buffer.alloc(0)
 for(const [key,value] of Object.entries(records)){
  const line=`${key}=${value}\n`
  let total=line.length+1
  while(String(total).length+1+line.length!==total)total++
  content=Buffer.concat([content,Buffer.from(String(total)+' '+line)])
 }
 const padding=Buffer.alloc((512-content.length%512)%512)
 return Buffer.concat([header('PaxHeader/record',content.length,'x'),content,padding])
}

test('archiveUrl maps git URLs to branch tarballs',()=>{
 assert.equal(archiveUrl('https://github.com/RazureSOFT/0KAY.git'),'https://github.com/RazureSOFT/0KAY/archive/refs/heads/main.tar.gz')
 assert.equal(archiveUrl('https://github.com/RazureSOFT/0KAY-agent'),'https://github.com/RazureSOFT/0KAY-agent/archive/refs/heads/main.tar.gz')
 assert.throws(()=>archiveUrl('https://example.com/repo.git'))
})
test('extractTarGz strips the top directory and honors pax paths',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-tar-'))
 try{
  const tar=Buffer.concat([
   entry('pkg-main/','', '5'),
   entry('pkg-main/hello.txt','hi'),
   entry('pkg-main/dir/a.txt','nested'),
   paxEntry({'path':'pkg-main/via-pax.txt'}),
   entry('ignored.txt','pax body'),
   Buffer.alloc(1024),
  ])
  extractTarGz(zlib.gzipSync(tar),root)
  assert.equal(await fs.readFile(path.join(root,'hello.txt'),'utf8'),'hi')
  assert.equal(await fs.readFile(path.join(root,'dir','a.txt'),'utf8'),'nested')
  assert.equal(await fs.readFile(path.join(root,'via-pax.txt'),'utf8'),'pax body')
  const top=await fs.readdir(root)
  assert.ok(!top.includes('pkg-main'),'top-level directory is stripped')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('extractTarGz rejects escaping paths',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-tar-x-'))
 try{
  const tar=Buffer.concat([entry('pkg-main/../evil.txt','nope'),Buffer.alloc(512)])
  assert.throws(()=>extractTarGz(zlib.gzipSync(tar),root),/escapes/)
  await assert.rejects(()=>fs.readFile(path.join(root,'..','evil.txt')))
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('archiveUrl selects branches and release tags',()=>{
 const repo='https://github.com/RazureSOFT/0KAY.git'
 assert.equal(archiveUrl(repo),'https://github.com/RazureSOFT/0KAY/archive/refs/heads/main.tar.gz')
 assert.equal(archiveUrl(repo,'main','v0.1.0'),'https://github.com/RazureSOFT/0KAY/archive/refs/tags/v0.1.0.tar.gz')
})
test('resolveProxy reads standard proxy environment variables',()=>{
 assert.equal(resolveProxy({}),null)
 assert.equal(resolveProxy({NO_PROXY:'x'}),null)
 assert.equal(resolveProxy({HTTPS_PROXY:'   '}),null)
 assert.equal(resolveProxy({HTTPS_PROXY:'socks5://127.0.0.1:7890'}),null)
 assert.equal(resolveProxy({HTTPS_PROXY:'http://127.0.0.1:7890'}).href,'http://127.0.0.1:7890/')
 assert.equal(resolveProxy({https_proxy:'http://10.0.0.1:8080'}).hostname,'10.0.0.1')
 assert.equal(resolveProxy({HTTP_PROXY:'http://proxy:8080'}).port,'8080')
 assert.equal(resolveProxy({ALL_PROXY:'http://all:3128'}).port,'3128')
})
function symlinkEntry(name,target){
 const buffer=header(name,0,'2')
 buffer.write(target.slice(0,100),157,'utf8')
 return buffer
}
test('extractTarGz materializes symlinks only when requested and rejects escapes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-tar-link-'))
 try{
  const tar=Buffer.concat([
   entry('pkg-main/','','5'),
   entry('pkg-main/real.txt','real'),
   symlinkEntry('pkg-main/link.txt','real.txt'),
   symlinkEntry('pkg-main/escape.txt','../../outside.txt'),
   Buffer.alloc(1024),
  ])
  extractTarGz(zlib.gzipSync(tar),root)
  assert.equal(existsSync(path.join(root,'link.txt')),false,'links ignored by default')
  extractTarGz(zlib.gzipSync(tar),root,{links:true})
  assert.equal(await fs.readFile(path.join(root,'link.txt'),'utf8'),'real')
  assert.equal(existsSync(path.join(root,'escape.txt')),false,'escaping links are skipped')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
