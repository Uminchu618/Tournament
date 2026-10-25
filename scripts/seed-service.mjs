import {readFile} from 'node:fs/promises';
import {cloudflare,loadEnv} from './env.mjs';
loadEnv();
const config=JSON.parse(await readFile('wrangler.staging.json','utf8'));
const credentials=JSON.parse(await readFile('.artifacts/access-staging.json','utf8'));
const now=new Date().toISOString();
const result=await cloudflare(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${config.d1_databases[0].database_id}/query`,{
  method:'POST',body:JSON.stringify({sql:`INSERT INTO operators(id,email,access_subject,role,created_at,updated_at) VALUES(?,?,?,'editor',?,?)
    ON CONFLICT(email) DO UPDATE SET access_subject=excluded.access_subject,active=1,updated_at=excluded.updated_at`,
  params:[crypto.randomUUID(),'e2e@tournament.invalid',`service:${credentials.clientId}`,now,now]})});
if(!result[0]?.success)throw new Error('検証用サービス運営者の登録に失敗しました');
console.log('検証用サービス運営者を登録しました（検証環境のみ）');
