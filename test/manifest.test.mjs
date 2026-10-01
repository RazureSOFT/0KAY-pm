import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import {validateManifest,within,packages} from '../src/installer.mjs'
test('all repository manifests validate',async()=>{for(const file of ['manifest.json','core/manifest.json','life/manifest.json','mocr/manifest.json','mcp/manifest.json','agent/manifest.json','webui/manifest.json']){const value=validateManifest(JSON.parse(await fs.readFile(new URL('../../'+file,import.meta.url),'utf8')));assert.ok(packages[value.name])}})
test('manifest paths and command shape are validated',()=>{assert.throws(()=>within(path.resolve('root'),'../outside'));assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:['npm install']}));assert.throws(()=>validateManifest({schema:2,name:'bad',version:'1'}))})
test('optional ui block shape is validated',()=>{
 assert.equal(validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],ui:{dir:'plugin-web/demo',plugin:'demo',dist:'dist',build:[['npm','run','build']]}}).ui.plugin,'demo')
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],ui:'dist'}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],ui:{plugin:'../evil'}}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],ui:{build:'npm'}}))
})
test('permissions block shape is validated',()=>{ const ok=validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],permissions:{api:{requires:['GET /api/models'],exposes:['agent.v1.AgentService/ExecuteTask']},egress:['api.example.com','127.0.0.1:8888']}})
 assert.deepEqual(ok.permissions.egress,['api.example.com','127.0.0.1:8888'])
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],permissions:'all'}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],permissions:{egress:'example.com'}}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],permissions:{api:{requires:['']}}}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],permissions:{egress:['bad\nhost']}}))
})
test('capabilities block shape is validated',()=>{
 const ok=validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],capabilities:{
  commands:[{name:'review',prompt:'review this'}],
  agents:[{name:'reviewer',prompt:'you review'}],
  hooks:[{event:'tool.before',command:['node','hook.js']}],
  mcpServers:[{id:'fs',transport:'stdio',command:'npx'}],
  skills:['skills/review'],
 }})
 assert.equal(ok.capabilities.commands[0].name,'review')
 assert.equal(ok.capabilities.mcpServers[0].id,'fs')
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],capabilities:'x'}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],capabilities:{commands:[{name:'a'}]}}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],capabilities:{hooks:[{event:'x',command:'node'}]}}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],capabilities:{mcpServers:[{transport:'stdio'}]}}))
 assert.throws(()=>validateManifest({schema:1,name:'@razuresoft/x',version:'1',install:[],capabilities:{skills:['']}}))
})
