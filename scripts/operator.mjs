import {readFile,writeFile} from 'node:fs/promises';
import {cloudflare,loadEnv} from './env.mjs';

loadEnv();
const [environment='staging',action='list',email,role='editor']=process.argv.slice(2);
if(!['staging','production'].includes(environment))throw new Error('stagingまたはproductionを指定してください');
const config=JSON.parse(await readFile(`wrangler.${environment}.json`,'utf8'));
const databaseId=config.d1_databases[0].database_id;
const path=`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`;
const query=async(sql,params=[])=>cloudflare(path,{method:'POST',body:JSON.stringify({sql,params})});
if(action==='list'){
  const result=await query('SELECT email,role,active FROM operators ORDER BY email');
  console.log(JSON.stringify(result[0].results,null,2));
}else{
  if(!email||!/^\S+@\S+\.\S+$/.test(email))throw new Error('対象メールを指定してください');
  if(action==='add'){
    if(!['admin','editor'].includes(role))throw new Error('adminまたはeditorを指定してください');
    const now=new Date().toISOString();
    const result=await query(`INSERT INTO operators(id,email,role,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET role=excluded.role,active=1,updated_at=excluded.updated_at
      WHERE operators.role!='admin' OR excluded.role='admin' OR (SELECT COUNT(*) FROM operators WHERE role='admin' AND active=1)>1`,[crypto.randomUUID(),email.toLowerCase(),role,now,now]);
    if(!result[0].meta.changes)throw new Error('最後の管理者の権限を下げることはできません');
  }else if(action==='disable'){
    const result=await query(`UPDATE operators SET active=0,updated_at=? WHERE email=?
      AND (role!='admin' OR (SELECT COUNT(*) FROM operators WHERE role='admin' AND active=1)>1)`,[new Date().toISOString(),email.toLowerCase()]);
    if(!result[0].meta.changes)throw new Error('対象が見つからないか、最後の管理者を停止しようとしています');
  }else throw new Error('list・add・disableを指定してください');
  console.log(`運営者操作 ${action}: 完了。Access側の許可メール設定も確認してください。`);
}
