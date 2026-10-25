import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {cloudflare,loadEnv} from './env.mjs';

loadEnv();
const base='https://tournament-board-production.uminchu.workers.dev';
const credentials=JSON.parse(await readFile('.artifacts/access-staging.json','utf8'));
const serviceHeaders={'CF-Access-Client-Id':credentials.clientId,'CF-Access-Client-Secret':credentials.clientSecret};
const checks=[];
for(const [name,path,expected,headers] of [
  ['health','/api/health',[200],{}],['config','/api/config',[200],{}],['home','/',[200],{}],
  ['anonymous-admin','/admin',[302,401,403],{}],['anonymous-api','/api/admin/me',[302,401,403],{}],
  ['staging-token-rejected','/api/admin/me',[302,401,403],serviceHeaders],['private-file','/.env',[404],{}],
]){
  const response=await fetch(base+path,{headers,redirect:'manual'});
  checks.push({name,status:response.status,passed:expected.includes(response.status)});
}
const config=JSON.parse(await readFile('wrangler.production.json','utf8'));
const count=await cloudflare(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${config.d1_databases[0].database_id}/query`,{method:'POST',body:JSON.stringify({sql:'SELECT COUNT(*) AS n FROM tournaments',params:[]})});
checks.push({name:'production-has-no-test-tournaments',count:count[0].results[0].n,passed:count[0].results[0].n===0});
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();await page.goto(`${base}/admin`);
  await page.locator('input[type=email]').waitFor({state:'visible',timeout:20_000});
  checks.push({name:'one-time-code-login-page',passed:true});
  await page.screenshot({path:'.artifacts/access-login.png'});
}catch{checks.push({name:'one-time-code-login-page',passed:false});}
finally{await browser.close();}
const report={checkedAt:new Date().toISOString(),environment:'production',checks,passed:checks.every(x=>x.passed)};
await writeFile('.artifacts/production-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
