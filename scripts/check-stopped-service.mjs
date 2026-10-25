import {readFile,writeFile} from 'node:fs/promises';
import {cloudflare,loadEnv} from './env.mjs';
loadEnv();
const config=JSON.parse(await readFile('wrangler.staging.json','utf8'));
const credentials=JSON.parse(await readFile('.artifacts/access-staging.json','utf8'));
const query=async(sql,params=[])=>cloudflare(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${config.d1_databases[0].database_id}/query`,{method:'POST',body:JSON.stringify({sql,params})});
const row=(await query('SELECT id,active FROM operators WHERE email=?',['e2e@tournament.invalid']))[0].results[0];
if(!row?.active)throw new Error('検証用サービスが有効ではありません');
const headers={'CF-Access-Client-Id':credentials.clientId,'CF-Access-Client-Secret':credentials.clientSecret};
const url='https://tournament-board-staging.uminchu.workers.dev/api/admin/me';
let stoppedStatus,restoredStatus;
try{
  await query('UPDATE operators SET active=0 WHERE id=?',[row.id]);
  stoppedStatus=(await fetch(url,{headers,redirect:'manual'})).status;
}finally{await query('UPDATE operators SET active=1 WHERE id=?',[row.id]);}
restoredStatus=(await fetch(url,{headers,redirect:'manual'})).status;
const report={environment:'staging',stoppedStatus,restoredStatus,passed:stoppedStatus===403&&restoredStatus===200};
await writeFile('.artifacts/stopped-service.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
