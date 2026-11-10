import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { unzipSync, strFromU8 } from 'fflate'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'))
const basename=`${manifest.id}-${manifest.version}-universal`
const archive=await fs.readFile(path.join(root,'dist',basename+'.dbxp'))
const metadata=JSON.parse(await fs.readFile(path.join(root,'dist',basename+'.artifact.json'),'utf8'))
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
assert.equal(hash(archive),metadata.sha256);assert.equal(archive.length,metadata.size);assert.equal(metadata.target,'universal')
const zip=unzipSync(archive),checks=JSON.parse(strFromU8(zip['checksums.json']))
assert.deepEqual(JSON.parse(strFromU8(zip['manifest.json'])),manifest)
assert.equal(manifest.engines.host_api,'^1.4');assert.ok(!manifest.permissions.some(x=>x.startsWith('host.directory:')))
for(const[name,digest]of Object.entries(checks.files))assert.equal(hash(zip[name]),digest,name)
assert.deepEqual(Object.keys(zip).filter(x=>x!=='checksums.json').sort(),Object.keys(checks.files).sort())
for(const[name,data]of Object.entries(zip))if(name.startsWith('ui/')||name.startsWith('assets/'))assert.equal(hash(data),hash(await fs.readFile(path.join(root,name))),name)
const targets=[]
for(const system of ['darwin','linux','windows'])for(const arch of ['x64','arm64']){
 const name=`bin/${system}-${arch}/dbx-dbdoc${system==='windows'?'.exe':''}`,data=Buffer.from(zip[name]??[])
 if(system==='darwin'){assert.equal(data.readUInt32LE(0),0xfeedfacf);assert.equal(data.readUInt32LE(4),arch==='x64'?0x1000007:0x100000c)}
 if(system==='linux'){assert.equal(data.subarray(0,4).toString('hex'),'7f454c46');assert.equal(data.readUInt16LE(18),arch==='x64'?62:183)}
 if(system==='windows'){assert.equal(data.subarray(0,2).toString(),'MZ');const offset=data.readUInt32LE(0x3c);assert.equal(data.readUInt32LE(offset),0x4550);assert.equal(data.readUInt16LE(offset+4),arch==='x64'?0x8664:0xaa64)}
 targets.push({target:system+'-'+arch,bytes:data.length,sha256:hash(data),architectureVerified:true})
}
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dbdoc package with spaces '))
let processCount=0
const children=new Set()
async function start(){
 const launcher=path.join(temp,'plugin/bin',process.platform==='win32'?'dbx-dbdoc.bat':'dbx-dbdoc')
 const options={cwd:temp,env:{...process.env,DBX_PLUGIN_DATA_DIR:path.join(temp,'app data')},stdio:['pipe','pipe','pipe'],windowsHide:true}
 const child=process.platform==='win32'?spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${launcher}""`],{...options,windowsVerbatimArguments:true}):spawn(launcher,[],options)
 children.add(child);child.once('exit',()=>children.delete(child))
 processCount++;let next=0;const pending=new Map();let diagnostics='';child.stderr.on('data',b=>diagnostics+=b.toString())
 readline.createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line),request=pending.get(message.id);if(request){pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result)}})
 child.on('error',error=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(error)}pending.clear()})
 child.on('exit',code=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error(`Backend exited ${code}: ${diagnostics}`))}pending.clear()})
 const call=(op,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Protocol timeout '+op))},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:op==='plugin/initialize'?op:'snapshotDirectory/'+op,params})+'\n')})
 const initialized=await call('plugin/initialize',{host:{protocolVersions:[1]}});assert.equal(initialized.plugin.version,manifest.version);assert.equal(initialized.protocolVersion,1)
 return {call,stop:()=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end()}),kill:()=>new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL')})}
}
try{
 for(const[name,data]of Object.entries(zip)){const output=path.join(temp,'plugin',name);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,data,{mode:0o644})}
 await fs.chmod(path.join(temp,'plugin/bin/dbx-dbdoc'),0o755)
 const name='dbdoc-'+'f'.repeat(64)+'.json',data=Buffer.from('snapshot UTF-8 \u91d1\u989d '.repeat(200000)),digest=hash(data)
 let instance=await start(),grants=await instance.call('listGrants'),original=grants.find(g=>g.preferred)
 const grant=await instance.call('request',{initialPath:path.join(temp,'custom snapshots')});assert.equal(grant.preferred,false)
 await instance.call('setPreferred',{grantId:grant.id})
 let write=await instance.call('beginWrite',{grantId:grant.id,path:name,expectedEtag:null})
 for(let offset=0;offset<data.length;offset+=524288)await instance.call('write',{handleId:write.handleId,offset,dataBase64:data.subarray(offset,offset+524288).toString('base64')})
 await instance.call('commit',{handleId:write.handleId,sha256:digest});await instance.stop()
 instance=await start();grants=await instance.call('listGrants');assert.equal(grants.find(g=>g.preferred).id,grant.id);assert.equal(grants.find(g=>g.id===original.id).preferred,false)
 const opened=await instance.call('openRead',{grantId:grant.id,path:name});assert.equal(opened.etag,digest)
 const chunks=[];for(let offset=0;offset<opened.size;offset+=524288){const part=await instance.call('read',{handleId:opened.handleId,offset,length:524288});chunks.push(Buffer.from(part.dataBase64,'base64'))}assert.deepEqual(Buffer.concat(chunks),data);await instance.call('close',{handleId:opened.handleId})
 write=await instance.call('beginWrite',{grantId:grant.id,path:name,expectedEtag:digest});await instance.call('write',{handleId:write.handleId,offset:0,dataBase64:Buffer.from('partial').toString('base64')});await instance.kill()
 instance=await start();assert.equal((await instance.call('stat',{grantId:grant.id,path:name})).etag,digest);assert.equal(hash(await fs.readFile(path.join(temp,'custom snapshots',name))),digest);await instance.stop()
 const result={version:manifest.version,target:'universal',sha256:metadata.sha256,size:archive.length,checksumsVerified:Object.keys(checks.files).length,manifestSemanticMatch:true,frontendAndAssetsMatch:true,hostApi:'^1.4',hostPatchRequired:false,backends:targets,packagedLauncherProtocol:{passed:true,platform:process.platform,arch:process.arch,restartedProcesses:processCount,snapshotBytes:data.length,customDirectoryRestored:true,interruptedWriteKeepsPrevious:true,extractionWithoutExecutableBitsSupported:process.platform!=='win32'},signed:false}
 await fs.writeFile(path.join(root,'docs',`package-verification-${manifest.version}.json`),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result,null,2))
}finally{await Promise.all([...children].map(child=>new Promise(resolve=>{child.once('exit',resolve);child.kill()})));await fs.rm(temp,{recursive:true,force:true})}
