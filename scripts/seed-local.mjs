import {writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

await mkdir('.artifacts',{recursive:true});
const now=new Date().toISOString();
await writeFile('.artifacts/seed-local.sql',`INSERT OR IGNORE INTO operators(id,email,role,created_at,updated_at) VALUES('local-dev','dev@localhost','admin','${now}','${now}');`);
const result=spawnSync(process.execPath,['scripts/run-wrangler.mjs','d1','execute','tournament-local','--local','--file','.artifacts/seed-local.sql'],{stdio:'inherit'});
process.exitCode=result.status??1;
