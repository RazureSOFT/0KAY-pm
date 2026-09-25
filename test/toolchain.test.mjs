import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {platformInfo,toolchainFor,isKnownToolchain,binDirs,executablePath,parseShasums,goFilename,nodeFilename,selectGoRelease,requiredGoVersion,ensureToolchain} from '../src/toolchain.mjs'

test('platformInfo maps runtime triplets for source archives',()=>{
 assert.deepEqual(platformInfo('linux','x64'),{platform:'linux',arch:'x64',goos:'linux',nodeOS:'linux',goArch:'amd64',nodeArch:'x64',triple:'x86_64-unknown-linux-gnu'})
 assert.equal(platformInfo('linux','arm64').triple,'aarch64-unknown-linux-gnu')
 assert.equal(platformInfo('darwin','arm64').triple,'aarch64-apple-darwin')
 assert.equal(platformInfo('win32','x64').triple,'x86_64-pc-windows-msvc')
 assert.equal(platformInfo('win32','x64').nodeOS,'win')
 assert.throws(()=>platformInfo('freebsd','x64'),/Unsupported platform/)
})

test('toolchain mapping only claims known build tools',()=>{
 assert.equal(toolchainFor('go'),'go')
 assert.equal(toolchainFor('python3'),'python')
 assert.equal(toolchainFor('python.exe'),'python')
 assert.equal(isKnownToolchain('go'),true)
 assert.equal(isKnownToolchain('definitely-missing-command-0kay'),false)
})

test('archive filenames follow official naming',()=>{
 assert.equal(goFilename('1.23.4',platformInfo('linux','x64')),'go1.23.4.linux-amd64.tar.gz')
 assert.equal(goFilename('1.23.4',platformInfo('win32','x64')),'go1.23.4.windows-amd64.zip')
 assert.equal(nodeFilename('22.12.0',platformInfo('linux','x64')),'node-v22.12.0-linux-x64.tar.gz')
 assert.equal(nodeFilename('22.12.0',platformInfo('win32','x64')),'node-v22.12.0-win-x64.zip')
 assert.equal(nodeFilename('22.12.0',platformInfo('darwin','arm64')),'node-v22.12.0-darwin-arm64.tar.gz')
})

test('parseShasums reads Node checksum manifests',()=>{
 const text=`${'a'.repeat(64)}  node-v22.12.0-linux-x64.tar.gz\n${'b'.repeat(64)} *node-v22.12.0-win-x64.zip\n`
 const map=parseShasums(text)
 assert.equal(map.get('node-v22.12.0-linux-x64.tar.gz'),'a'.repeat(64))
 assert.equal(map.get('node-v22.12.0-win-x64.zip'),'b'.repeat(64))
})

test('binDirs and executablePath are platform aware',()=>{
 const dir=path.join(path.sep,'home','.0kay','toolchains','go','1.23.4')
 assert.deepEqual(binDirs('go',dir,'linux'),[path.join(dir,'bin')])
 assert.deepEqual(binDirs('node',dir,'win32'),[dir])
 assert.deepEqual(binDirs('python',dir,'win32'),[dir,path.join(dir,'Scripts')])
 assert.match(executablePath('go',dir,'linux'),/bin[\\/]go$/)
 assert.equal(executablePath('go',dir,'win32'),path.join(dir,'bin','go.exe'))
})

test('selectGoRelease picks the exact patch or the newest same-minor patch',()=>{
 const releases=[{version:'go1.27.1'},{version:'go1.27.0'},{version:'go1.26.8'},{version:'go1.27rc3'}]
 assert.equal(selectGoRelease(releases,'1.27.0').version,'go1.27.0')
 assert.equal(selectGoRelease(releases,'1.27.2').version,'go1.27.1')
 assert.equal(selectGoRelease(releases,'1.27').version,'go1.27.1')
 assert.equal(selectGoRelease(releases,'1.28.0'),null)
 assert.equal(selectGoRelease([],'1.27.0'),null)
})

test('requiredGoVersion reads go.mod and the toolchain directive',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'0kay-pm-gomod-'))
 try{
  const nested=path.join(root,'a','b');await fs.mkdir(nested,{recursive:true})
  await fs.writeFile(path.join(root,'a','go.mod'),'module x\n\ngo 1.27.0\n')
  assert.equal(await requiredGoVersion(nested),'1.27.0')
  await fs.writeFile(path.join(root,'a','go.mod'),'module x\n\ngo 1.27\n')
  assert.equal(await requiredGoVersion(nested),'1.27.0')
  await fs.writeFile(path.join(root,'a','go.mod'),'module x\n\ngo 1.24.0\ntoolchain go1.27.3\n')
  assert.equal(await requiredGoVersion(nested),'1.27.3')
 }finally{await fs.rm(root,{recursive:true,force:true})}
 assert.equal(await requiredGoVersion(os.tmpdir()),null)
})

test('ensureToolchain returns null when downloads are disabled or the tool is unknown',async()=>{
 assert.equal(await ensureToolchain('definitely-missing-command-0kay',{allowDownload:true}),null)
 assert.equal(await ensureToolchain('go',{home:path.join(os.tmpdir(),'0kay-pm-none'),allowDownload:false}),null)
})
