import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {shellQuote,cmdQuote,renderPosixWrapper,renderWindowsWrapper,renderSystemdUnit,renderLaunchdPlist} from '../src/service.mjs'

test('shellQuote wraps words and escapes single quotes',()=>{
 assert.equal(shellQuote('plain'),"'plain'")
 assert.equal(shellQuote("it's"),"'it'\\''s'")
 assert.equal(shellQuote('a b'),"'a b'")
})

test('cmdQuote wraps and escapes percent/quotes',()=>{
 assert.equal(cmdQuote('plain'),'"plain"')
 assert.equal(cmdQuote('100%'),'"100%%"')
})

test('renderPosixWrapper exports env, cd and execs the command',()=>{
 const wrapper=renderPosixWrapper({
  name:'0kay-core',command:['/abs/core-service.exe','--flag'],cwd:'/srv/0kay core',
  env:{CORE_HTTP_PORT:'11412',CORE_BIND_HOST:'0.0.0.0'},binDirs:['/home/u/.0kay/toolchains/go/1.27.0/bin'],
 }, '/home/u/.0kay')
 assert.match(wrapper,/^#!\/bin\/sh/)
 assert.match(wrapper,/export CORE_HTTP_PORT='11412'/)
 assert.match(wrapper,/export CORE_BIND_HOST='0.0.0.0'/)
 assert.match(wrapper,/toolchains\/go\/1\.27\.0\/bin/)
 assert.match(wrapper,/cd '\/srv\/0kay core' \|\| exit 1/)
 assert.match(wrapper,/exec '\/abs\/core-service\.exe' '--flag'/)
})

test('renderWindowsWrapper sets env and runs the command',()=>{
 const wrapper=renderWindowsWrapper({
  name:'0kay-core',command:['C:\\app\\core.exe'],cwd:'C:\\app',env:{CORE_HTTP_PORT:'11412'},binDirs:[],
 }, 'C:\\Users\\u\\.0kay')
 assert.match(wrapper,/@echo off/)
 assert.match(wrapper,/set "CORE_HTTP_PORT=11412"/)
 assert.match(wrapper,/cd \/d "C:\\app"/)
 assert.match(wrapper,/"C:\\app\\core\.exe"/)
})

test('renderSystemdUnit is a restart-on-failure user service',()=>{
 const unit=renderSystemdUnit({name:'0kay-life',cwd:'/srv/100%/life'},'/home/u/.0kay/services/0kay-life.sh')
 assert.match(unit,/\[Service\]/)
 assert.match(unit,/ExecStart=\/bin\/sh "\/home\/u\/\.0kay\/services\/0kay-life\.sh"/)
 assert.match(unit,/Restart=always/)
 assert.match(unit,/WantedBy=default\.target/)
 assert.match(unit,/WorkingDirectory="\/srv\/100%%\/life"/,'percent signs are escaped for systemd')
})

test('renderLaunchdPlist keeps the agent alive and logs output',()=>{
 const plist=renderLaunchdPlist({name:'0kay-mocr'},'/home/u/.0kay/services/0kay-mocr.sh','/home/u/.0kay/logs/0kay-mocr.log')
 assert.match(plist,/<key>Label<\/key><string>com\.0kay\.0kay-mocr<\/string>/)
 assert.match(plist,/<key>RunAtLoad<\/key><true\/>/)
 assert.match(plist,/<key>KeepAlive<\/key><true\/>/)
 assert.match(plist,/0kay-mocr\.log/)
})
