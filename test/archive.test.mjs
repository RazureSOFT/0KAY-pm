import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import {archiveUrl,extractTarGz} from '../src/installer.mjs'

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
