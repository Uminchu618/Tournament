import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker from '../src/worker.js';
import {emptyDocument,asEvent} from '../src/model.js';
import {cleanup} from '../src/repository.js';

const migration=await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
class SQLiteD1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec('PRAGMA foreign_keys=ON');this.sqlite.exec(migration);}
  prepare(text){
    const database=this;
    return {args:[],bind(...args){this.args=args;return this;},
      async first(){return database.sqlite.prepare(text).get(...this.args)??null;},
      async all(){return {results:database.sqlite.prepare(text).all(...this.args)};},
      async run(){const result=database.sqlite.prepare(text).run(...this.args);return {success:true,meta:{changes:Number(result.changes)}};},
    };
  }
  async batch(statements){
    this.sqlite.exec('BEGIN');
    try{const result=[];for(const statement of statements)result.push(await statement.run());this.sqlite.exec('COMMIT');return result;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
}
function fixture(){
  const DB=new SQLiteD1();const now=new Date().toISOString();
  DB.sqlite.prepare('INSERT INTO operators(id,email,role,created_at,updated_at) VALUES(?,?,?,?,?)').run('dev','dev@localhost','admin',now,now);
  const env={DB,ENVIRONMENT:'local',ASSETS:{fetch:async()=>new Response('<html>app</html>')}};
  const api=async(path,{method='GET',body,headers={},origin='http://localhost'}={})=>{
    const result=await worker.fetch(new Request(`http://localhost${path}`,{method,headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...headers},body:body?JSON.stringify(body):undefined}),env);
    return {status:result.status,headers:result.headers,body:result.status===304?null:await result.json()};
  };
  const create=()=>api('/api/admin/tournaments',{method:'POST',body:{mutationId:crypto.randomUUID()}});
  return {DB,env,api,create};
}
const bracket=()=>({...emptyDocument(),title:'日本語大会',participants:['東京','大阪','福岡','札幌'].map((name,i)=>({id:`p${i+1}`,name})),slots:['p1','p2','p3','p4']});
async function save(f,record,document,extra={}){return f.api(`/api/admin/tournaments/${record.id}/draft`,{method:'PUT',body:{mutationId:crypto.randomUUID(),expectedLockVersion:record.lockVersion,document,...extra}});}
async function publish(f,record){return f.api(`/api/admin/tournaments/${record.id}/publish`,{method:'POST',body:{mutationId:crypto.randomUUID(),expectedLockVersion:record.lockVersion,targetRevision:record.draftRevision}});}

test('D1保存と公開の分離、公開停止、ETag、他大会の独立',async()=>{
  const f=fixture();let record=(await f.create()).body;
  const other=(await f.create()).body;
  assert.equal((await f.api(`/api/public/tournaments/${record.slug}`)).status,404);
  record=(await save(f,record,bracket())).body;
  record=(await publish(f,record)).body;
  const url=`/api/public/tournaments/${record.slug}`,publicA=await f.api(url);
  assert.equal(publicA.body.document.title,'日本語大会');
  assert.equal((await f.api(url,{headers:{'If-None-Match':publicA.headers.get('etag')}})).status,304);
  const publishedRevision=record.publishedRevision;
  record=(await save(f,record,{...bracket(),title:'下書きB'})).body;
  assert.equal((await f.api(url)).body.document.title,'日本語大会');
  assert.equal((await f.api(`/api/admin/tournaments/${other.id}`)).body.document.title,'');
  assert.equal((await publish(f,{...record,lockVersion:record.lockVersion-1})).status,409);
  record=(await publish(f,record)).body;
  assert.notEqual(record.publishedRevision,publishedRevision);
  assert.equal((await f.api(url)).body.document.title,'下書きB');
  assert.equal((await f.api(url,{headers:{'If-None-Match':publicA.headers.get('etag')}})).status,200);
  const stopped=await f.api(`/api/admin/tournaments/${record.id}/unpublish`,{method:'POST',body:{mutationId:crypto.randomUUID(),expectedLockVersion:record.lockVersion}});
  assert.equal(stopped.status,200);assert.equal((await f.api(url)).status,404);
  assert.equal((await f.api('/api/public/tournaments')).status,404);
  f.DB.sqlite.close();
});

test('競合した更新では版と操作記録を追加しない',async()=>{
  const f=fixture(),record=(await f.create()).body;
  assert.equal((await save(f,record,bracket())).status,200);
  const versions=f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tournament_revisions').get().n;
  const events=f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  assert.equal((await save(f,record,{...bracket(),title:'古い画面'})).status,409);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tournament_revisions').get().n,versions);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,events);
  f.DB.sqlite.close();
});

test('応答消失後の同一操作の再送と異なる要求でのID再利用',async()=>{
  const f=fixture(),record=(await f.create()).body;
  const body={mutationId:crypto.randomUUID(),expectedLockVersion:record.lockVersion,document:bracket()},path=`/api/admin/tournaments/${record.id}/draft`;
  const first=await f.api(path,{method:'PUT',body});assert.equal(first.status,200);
  const retry=await f.api(path,{method:'PUT',body});assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);assert.equal(retry.body.lockVersion,first.body.lockVersion);
  assert.equal((await f.api(path,{method:'PUT',body:{...body,document:{...bracket(),title:'別要求'}}})).status,409);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tournament_revisions').get().n,2);
  f.DB.sqlite.close();
});

test('結果訂正の取消確認をサーバーでも必須にし、得点と注記を保存する',async()=>{
  const f=fixture();let record=(await f.create()).body;
  const document={...bracket(),results:{'R1-M1':'p1','R1-M2':'p3','R2-M1':'p1'},matchDetails:{'R1-M1':{scoreA:3,scoreB:2,scheduledAt:'2026-11-01T09:00:00+09:00',venue:'第1会場',notes:'棄権の注記'},'R2-M1':{scoreA:5,scoreB:2,venue:'決勝会場'}}};
  record=(await save(f,record,document)).body;
  assert.equal(record.document.matchDetails['R1-M1'].venue,'第1会場');
  const changed={...record.document,results:{'R1-M1':'p2','R1-M2':'p3'}};
  const denied=await save(f,record,changed);assert.equal(denied.status,409);assert.deepEqual(denied.body.affectedMatches,['R2-M1']);
  const accepted=await save(f,record,changed,{acknowledgedMatches:['R2-M1']});assert.equal(accepted.status,200);
  assert.equal(accepted.body.document.results['R2-M1'],undefined);
  assert.equal(accepted.body.document.matchDetails['R2-M1'].scoreA,null);
  assert.equal(accepted.body.document.matchDetails['R2-M1'].venue,'決勝会場');
  f.DB.sqlite.close();
});

test('バッチ途中のSQL失敗をロールバックする',async()=>{
  const f=fixture(),record=(await f.create()).body;
  f.DB.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='save' BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  assert.equal((await save(f,record,bracket())).status,503);
  assert.equal((await f.api(`/api/admin/tournaments/${record.id}`)).body.lockVersion,1);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tournament_revisions').get().n,1);
  f.DB.sqlite.close();
});

test('未設定認証、停止済み、別Origin、巨大JSONを拒否する',async()=>{
  const f=fixture();
  let response=await worker.fetch(new Request('https://example.workers.dev/api/admin/me'),{...f.env,ENVIRONMENT:'production'});assert.equal(response.status,503);
  assert.equal((await f.api('/api/admin/tournaments',{method:'POST',body:{mutationId:crypto.randomUUID()},origin:'https://another.example'})).status,403);
  assert.equal((await f.api('/api/admin/tournaments',{method:'POST',body:{mutationId:crypto.randomUUID(),large:'あ'.repeat(100000)}})).status,413);
  f.DB.sqlite.exec('UPDATE operators SET active=0');
  assert.equal((await f.api('/api/admin/me')).status,403);
  response=await worker.fetch(new Request('https://remote.example/admin'),{...f.env,ENVIRONMENT:'local'});assert.equal(response.status,503);
  f.DB.sqlite.close();
});

test('公開版と編集版は定期整理で消さず、古い中間版だけを削除する',async()=>{
  const f=fixture();let record=(await f.create()).body;record=(await save(f,record,bracket())).body;record=(await publish(f,record)).body;
  record=(await save(f,record,{...bracket(),title:'次の下書き'})).body;
  f.DB.sqlite.exec("UPDATE tournament_revisions SET created_at='2020-01-01T00:00:00Z'");
  await cleanup(f.DB);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tournament_revisions').get().n,2);
  assert.equal((await f.api(`/api/public/tournaments/${record.slug}`)).status,200);
  f.DB.sqlite.close();
});

test('部門別の結果を永続化し、取消確認と公開版を大会単位で管理する',async()=>{
  const f=fixture();let record=(await f.create()).body;
  const event=asEvent({...bracket(),results:{'R1-M1':'p1','R1-M2':'p3','R2-M1':'p1'}});
  event.divisions[0].participants[0].organization='城南中学校';
  event.divisions.push({...structuredClone(event.divisions[0]),id:'team',name:'団体戦',type:'team'});
  record=(await save(f,record,event)).body;
  assert.equal(record.document.divisions.length,2);
  record=(await publish(f,record)).body;
  const changed=structuredClone(record.document);changed.divisions[0].results['R1-M1']='p2';
  const rejected=await save(f,record,changed);
  assert.equal(rejected.status,409);assert.deepEqual(rejected.body.affectedMatches,['main/R2-M1']);
  const accepted=await save(f,record,changed,{acknowledgedMatches:['main/R2-M1']});
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.document.divisions[0].results['R2-M1'],undefined);
  assert.equal(accepted.body.document.divisions[1].results['R2-M1'],'p1');
  const visible=(await f.api(`/api/public/tournaments/${record.slug}`)).body.document;
  assert.equal(visible.divisions[0].results['R2-M1'],'p1');
  assert.equal(visible.divisions[0].participants[0].organization,'城南中学校');
  f.DB.sqlite.close();
});
