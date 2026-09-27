import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {selfUpdateTarget} from '../src/installer.mjs'

const CODELOAD='https://codeload.github.com/RazureSOFT/0KAY-pm/tar.gz'

test('self-update targets a release tag',()=>{
 assert.equal(selfUpdateTarget({version:'0.1.2'}),`${CODELOAD}/v0.1.2`)
})

test('self-update accepts a v-prefixed version',()=>{
 assert.equal(selfUpdateTarget({version:'v0.1.2'}),`${CODELOAD}/v0.1.2`)
})

test('self-update defaults to the main branch',()=>{
 assert.equal(selfUpdateTarget({}),`${CODELOAD}/main`)
})

test('self-update honors the gh-proxy mirror',()=>{
 assert.equal(selfUpdateTarget({version:'0.1.2',mirror:true}),`https://gh-proxy.com/${CODELOAD}/v0.1.2`)
})

test('self-update honors a custom mirror prefix',()=>{
 assert.equal(selfUpdateTarget({version:'0.1.2',mirror:'https://gh.example.com/'}),`https://gh.example.com/${CODELOAD}/v0.1.2`)
})

test('self-update can reinstall from a local checkout',()=>{
 const target=selfUpdateTarget({source:'./pm'})
 assert.equal(path.isAbsolute(target),true)
 assert.equal(target.endsWith('pm'),true)
})
