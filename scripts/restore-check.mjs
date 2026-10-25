import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {decryptBackup} from './backup.mjs';
import {orderDump} from './sql-dump.mjs';

const path=process.argv[2]??JSON.parse(await readFile('.artifacts/backup-latest.json','utf8')).path;
const sql=await decryptBackup(path);
await mkdir('.artifacts/restore',{recursive:true,mode:0o700});
const temporary=await mkdtemp('.artifacts/restore/check-');
const config=resolve(temporary,'wrangler.json');
const source=resolve(temporary,'backup.sql');
const database='tournament-restore-check';
const run=(args)=>spawnSync(process.execPath,['scripts/run-wrangler.mjs',...args,'--config',config,'--persist-to',resolve(temporary,'state')],{encoding:'utf8',maxBuffer:10*1024*1024});
try{
  await writeFile(source,orderDump(sql.toString('utf8')),{mode:0o600});
  await writeFile(config,JSON.stringify({d1_databases:[{binding:'DB',database_name:database,database_id:crypto.randomUUID()}]}));
  const restored=run(['d1','execute',database,'--local','--file',source]);
  if(restored.status!==0){await writeFile('.artifacts/restore-error.log',restored.stderr);throw new Error('ローカル復元に失敗しました');}
  const checked=run(['d1','execute',database,'--local','--command','PRAGMA foreign_key_check; SELECT (SELECT COUNT(*) FROM tournaments) AS tournaments,(SELECT COUNT(*) FROM tournament_revisions) AS revisions,(SELECT COUNT(*) FROM operators) AS operators;','--json']);
  if(checked.status!==0)throw new Error('復元後の整合性検証に失敗しました');
  const results=JSON.parse(checked.stdout);
  if(results[0].results.length)throw new Error('復元したデータに外部キーの不整合があります');
  const report={checkedAt:new Date().toISOString(),target:'一時的なローカルD1（リモートDBへの書き戻しなし）',foreignKeyCheck:'passed',counts:results.at(-1).results[0],passed:true};
  await writeFile('.artifacts/restore-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await rm(temporary,{recursive:true,force:true});}
