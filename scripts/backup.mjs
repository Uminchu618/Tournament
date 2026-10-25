import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {loadEnv} from './env.mjs';

loadEnv();
export async function backupKey(){
  if(process.env.BACKUP_ENCRYPTION_KEY){const key=Buffer.from(process.env.BACKUP_ENCRYPTION_KEY,'base64');if(key.length!==32)throw new Error('BACKUP_ENCRYPTION_KEYは32バイトのBase64を指定してください');return key;}
  const path='.artifacts/backup-key';
  if(existsSync(path))return Buffer.from((await readFile(path,'utf8')).trim(),'base64');
  if(process.env.CI)throw new Error('CIにはBACKUP_ENCRYPTION_KEYを設定してください');
  await mkdir('.artifacts',{recursive:true});const key=randomBytes(32);await writeFile(path,key.toString('base64'),{mode:0o600});return key;
}
export async function decryptBackup(path){
  const data=JSON.parse(await readFile(path,'utf8'));
  if(data.format!==1)throw new Error('バックアップ形式が未対応です');
  const decipher=createDecipheriv('aes-256-gcm',await backupKey(),Buffer.from(data.iv,'base64'));
  decipher.setAuthTag(Buffer.from(data.tag,'base64'));
  return gunzipSync(Buffer.concat([decipher.update(Buffer.from(data.ciphertext,'base64')),decipher.final()]));
}
if(import.meta.url===new URL(process.argv[1],'file:').href){
  const environment=process.argv[2]??'staging';if(!['staging','production'].includes(environment))throw new Error('環境名を確認してください');
  const config=JSON.parse(await readFile(`wrangler.${environment}.json`,'utf8'));
  await mkdir('.artifacts/backups',{recursive:true,mode:0o700});
  const plain=`.artifacts/backups/${environment}-temporary.sql`,createdAt=new Date().toISOString();
  const output=`.artifacts/backups/${environment}-${createdAt.replaceAll(':','-')}.json.enc`;
  try{
    // Wrangler prints a temporary signed download URL; keep it out of logs.
    const exportResult=spawnSync(process.execPath,['scripts/run-wrangler.mjs','d1','export',config.d1_databases[0].database_name,'--config',`wrangler.${environment}.json`,'--remote','--output',plain],{encoding:'utf8',maxBuffer:5*1024*1024});
    if(exportResult.status!==0)throw new Error('D1エクスポートに失敗しました');
    const sql=await readFile(plain),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await backupKey(),iv);
    const encrypted=Buffer.concat([cipher.update(gzipSync(sql)),cipher.final()]);
    await writeFile(output,JSON.stringify({format:1,environment,createdAt,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')}),{mode:0o600});
    if(!(await decryptBackup(output)).equals(sql))throw new Error('暗号化バックアップの検証に失敗しました');
    await writeFile('.artifacts/backup-latest.json',JSON.stringify({environment,createdAt,path:output,verified:true}));
    console.log(`暗号化バックアップを保存・復号検証しました: ${output}`);
  }finally{await rm(plain,{force:true});}
}
