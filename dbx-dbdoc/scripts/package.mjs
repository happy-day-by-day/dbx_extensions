// One installable archive, with a shared launcher and every supported backend.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))
if (process.argv.length > 2) throw new Error('This builds one package; platform arguments are unnecessary')
const targets = [['darwin','arm64','arm64'],['darwin','x64','amd64'],['linux','arm64','arm64'],['linux','x64','amd64'],['windows','arm64','arm64'],['windows','x64','amd64']]
function run(command,args,options={}) { return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit',...options});child.on('error',reject);child.on('close',(code)=>code===0?resolve():reject(new Error(`${command} exited ${code}`)))}) }
await fs.mkdir(path.join(root,'dist'),{recursive:true})
const stage = await fs.mkdtemp(path.join(root,'dist/.universal-stage-'))
try {
  await Promise.all(['ui','assets'].map(name=>fs.cp(path.join(root,name),path.join(stage,name),{recursive:true})))
  await fs.copyFile(path.join(root,'manifest.json'),path.join(stage,'manifest.json'))
  await fs.mkdir(path.join(stage,'bin'),{recursive:true})
  for(const name of ['dbx-dbdoc','dbx-dbdoc.bat'])await fs.copyFile(path.join(root,'scripts/launchers',name),path.join(stage,'bin',name))
  await fs.chmod(path.join(stage,'bin/dbx-dbdoc'),0o755)
  // Two compilers at a time keep release builds within ordinary laptop memory.
  for(let i=0;i<targets.length;i+=2)await Promise.all(targets.slice(i,i+2).map(async([os,arch,goarch])=>{
    const dir=path.join(stage,'bin',`${os}-${arch}`);await fs.mkdir(dir,{recursive:true})
    const binary=path.join(dir,os==='windows'?'dbx-dbdoc.exe':'dbx-dbdoc')
    await run('go',['build','-trimpath','-ldflags=-s -w -buildid=','-o',binary,'.'],{cwd:path.join(root,'backend'),env:{...process.env,CGO_ENABLED:'0',GOOS:os,GOARCH:goarch}})
    await fs.chmod(binary,0o755)
  }))
  const packagerDir=path.join(root,'tooling/dbx-plugin-packager')
  await run(process.env.CARGO_BIN||'cargo',['build','--locked','--target-dir',path.join(packagerDir,'target'),'--manifest-path',path.join(packagerDir,'Cargo.toml'),'--bin','dbx-plugin-packager'])
  const packager=path.join(packagerDir,'target/debug',process.platform==='win32'?'dbx-plugin-packager.exe':'dbx-plugin-packager')
  const name=`${manifest.id}-${manifest.version}-universal`
  const output=path.join(root,'dist',name+'.dbxp'),metadata=path.join(root,'dist',name+'.artifact.json')
  await run(packager,[stage,output,'--artifact-metadata',metadata,'--target','universal','--artifact-url',name+'.dbxp'])
  const archive=await fs.readFile(output),zip=unzipSync(archive),packaged=JSON.parse(strFromU8(zip['manifest.json']))
  if(packaged.entrypoints.backend.executable!=='bin/dbx-dbdoc')throw new Error('Shared launcher missing')
  for(const[os,arch]of targets)if(!zip[`bin/${os}-${arch}/dbx-dbdoc${os==='windows'?'.exe':''}`])throw new Error('Missing backend '+os+'-'+arch)
  const checks=JSON.parse(strFromU8(zip['checksums.json']))
  for(const[name,digest]of Object.entries(checks.files))if(crypto.createHash('sha256').update(zip[name]).digest('hex')!==digest)throw new Error('Checksum mismatch: '+name)
  console.log(`Built ${output}: one package, six backends, no host patch or separate runtime required`)
}finally{await fs.rm(stage,{recursive:true,force:true})}
