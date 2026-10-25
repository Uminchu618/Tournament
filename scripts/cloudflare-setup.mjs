import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {cloudflare,loadEnv} from './env.mjs';

loadEnv();
const environment=process.argv[2]??'staging';
if(!['staging','production'].includes(environment))throw new Error('stagingまたはproductionを指定してください');
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!account)throw new Error('Account IDが未設定です');
const adminEmail=process.env.ADMIN_EMAIL??process.argv[3];
if(!adminEmail||!/^\S+@\S+\.\S+$/.test(adminEmail))throw new Error('初期管理者メールを引数またはADMIN_EMAILに指定してください');
await mkdir('.artifacts',{recursive:true});
const root=`/accounts/${account}`;
const name=`tournament-board-${environment}`;
const subdomain=await cloudflare(`${root}/workers/subdomain`);
const hostname=`${name}.${subdomain.subdomain}.workers.dev`;
const databases=await cloudflare(`${root}/d1/database?per_page=100`);
let database=databases.find(x=>x.name===name);
if(!database)database=await cloudflare(`${root}/d1/database`,{method:'POST',body:JSON.stringify({name})});
console.log(`D1 ${name}: 準備済み`);

let access={};
try{
  const organization=await cloudflare(`${root}/access/organizations`);
  if(!organization?.auth_domain)throw new Error('Zero Trust組織の初期設定が必要です');
  const providers=await cloudflare(`${root}/access/identity_providers`);
  const otp=providers.find(x=>x.type==='onetimepin')??await cloudflare(`${root}/access/identity_providers`,{method:'POST',body:JSON.stringify({name:'Tournament one-time PIN',type:'onetimepin',config:{}})});
  const apps=await cloudflare(`${root}/access/apps?per_page=100`);
  let app=apps.find(x=>x.name===name);
  const appBody={name,type:'self_hosted',domain:`${hostname}/admin`,self_hosted_domains:[`${hostname}/admin`,`${hostname}/api/admin`],session_duration:'12h',auto_redirect_to_identity:false,allowed_idps:[otp.id],app_launcher_visible:false};
  if(!app)app=await cloudflare(`${root}/access/apps`,{method:'POST',body:JSON.stringify(appBody)});
  else if(app.allowed_idps?.length!==1||app.allowed_idps[0]!==otp.id)app=await cloudflare(`${root}/access/apps/${app.id}`,{method:'PUT',body:JSON.stringify(appBody)});
  const policies=await cloudflare(`${root}/access/apps/${app.id}/policies`);
  if(!policies.some(x=>x.name==='Tournament operators'))await cloudflare(`${root}/access/apps/${app.id}/policies`,{method:'POST',body:JSON.stringify({name:'Tournament operators',decision:'allow',include:[{email:{email:adminEmail}}]})});
  access={ACCESS_TEAM_DOMAIN:organization.auth_domain,ACCESS_AUD:app.aud};
  if(environment==='staging'){
    const credentialPath='.artifacts/access-staging.json';
    let credentials;
    try{credentials=JSON.parse(await readFile(credentialPath,'utf8'));}catch{}
    if(!credentials){
      const service=await cloudflare(`${root}/access/service_tokens`,{method:'POST',body:JSON.stringify({name:'Tournament staging E2E',duration:'720h'})});
      credentials={clientId:service.client_id,clientSecret:service.client_secret,id:service.id};
      await writeFile(credentialPath,JSON.stringify(credentials),{mode:0o600});
    }
    if(!policies.some(x=>x.name==='Tournament staging E2E'))await cloudflare(`${root}/access/apps/${app.id}/policies`,{method:'POST',body:JSON.stringify({name:'Tournament staging E2E',decision:'non_identity',include:[{service_token:{token_id:credentials.id}}]})});
    access.E2E_SERVICE_CLIENT_ID=credentials.clientId;
  }
  console.log('Access: 準備済み');
}catch(error){
  console.log(error.accessNotEnabled?'Access: 初回有効化が必要です。CloudflareのZero Trust初期設定を完了してください。':`Access: 未完了 (${error.message})。`);
  console.log('管理APIは認証設定完了まで操作を拒否します。');
  try{const old=JSON.parse(await readFile(`wrangler.${environment}.json`,'utf8'));if(old.vars?.ACCESS_AUD)access={...old.vars};}catch{}
}

const base=JSON.parse(await readFile('wrangler.jsonc','utf8'));
const config={...base,name,vars:{ENVIRONMENT:environment,PUBLIC_POLL_SECONDS:'300',...access},
  d1_databases:[{binding:'DB',database_name:name,database_id:database.uuid,migrations_dir:'migrations'}],
  triggers:{crons:['0 18 * * *']}};
await writeFile(`wrangler.${environment}.json`,`${JSON.stringify(config,null,2)}\n`);
await writeFile(`.artifacts/setup-${environment}.json`,JSON.stringify({databaseId:database.uuid,hostname,adminEmail,accessConfigured:!!access.ACCESS_AUD}),{mode:0o600});
console.log(`構成ファイル: wrangler.${environment}.json`);
if(!access.ACCESS_AUD)process.exitCode=1;

// Initial operator is seeded after the schema has been applied by the deploy script.
