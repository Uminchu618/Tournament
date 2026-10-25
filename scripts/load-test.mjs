import {readFile,writeFile} from 'node:fs/promises';

const base=process.argv[2]??'https://tournament-board-staging.uminchu.workers.dev';
const count=Number(process.argv[3]??1000);
const full=process.argv[4]==='full';
if(!/^https:\/\/tournament-board-staging\.[a-z0-9-]+\.workers\.dev$/.test(base)||!Number.isSafeInteger(count)||count<1||count>1000)throw new Error('検証環境・最大1000要求に限定しています');
const credentials=JSON.parse(await readFile('.artifacts/access-staging.json','utf8'));
const ids=JSON.parse(await readFile('.artifacts/e2e-created.json','utf8'));
const record=await (await fetch(`${base}/api/admin/tournaments/${ids.at(-1)}`,{headers:{'CF-Access-Client-Id':credentials.clientId,'CF-Access-Client-Secret':credentials.clientSecret}})).json();
if(!record.slug)throw new Error('公開用の検証大会がありません');
const path=`${base}/api/public/tournaments/${record.slug}`;
const initial=await fetch(path);if(!initial.ok)throw new Error('検証大会が公開されていません');
const etag=initial.headers.get('etag');await initial.arrayBuffer();
const start=performance.now();
const samples=await Promise.all(Array.from({length:count},async()=>{
  const t=performance.now();
  try{const r=await fetch(path,{headers:full?{}:{'If-None-Match':etag},signal:AbortSignal.timeout(30_000)});await r.arrayBuffer();return {status:r.status,ms:performance.now()-t};}
  catch{return {status:0,ms:performance.now()-t};}
}));
const sorted=samples.map(x=>x.ms).sort((a,b)=>a-b),statuses={};
for(const sample of samples)statuses[sample.status]=(statuses[sample.status]??0)+1;
const report={environment:'staging',mode:full?'初回取得（200）':'更新確認（304）',kind:'HTTP同時リクエスト（ブラウザー1000台の試験ではない）',requests:count,elapsedMs:Math.round(performance.now()-start),p50Ms:Math.round(sorted[Math.floor(sorted.length*.5)]),p95Ms:Math.round(sorted[Math.floor(sorted.length*.95)]),statuses,passed:samples.every(x=>x.status===(full?200:304))};
await writeFile(full?'.artifacts/load-test-full.json':'.artifacts/load-test.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
