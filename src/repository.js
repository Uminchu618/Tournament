import {HttpError} from './errors.js';

const sql=(db,text,...args)=>db.prepare(text).bind(...args);
const time=()=>new Date().toISOString();
export async function requestHash(body) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

export async function getTournament(db,id) {
  const row=await sql(db,`SELECT t.*, r.document_json FROM tournaments t JOIN tournament_revisions r
    ON r.tournament_id=t.id AND r.revision=t.draft_revision WHERE t.id=?`,id).first();
  if (!row) throw new HttpError(404,'大会が見つかりません');
  return {id:row.id,slug:row.slug,draftRevision:row.draft_revision,publishedRevision:row.published_revision,
    lockVersion:row.lock_version,updatedAt:row.updated_at,publishedAt:row.published_at,document:JSON.parse(row.document_json)};
}

export async function listTournaments(db,offset=0) {
  const {results}=await sql(db,`SELECT t.id,t.slug,t.draft_revision AS draftRevision,t.published_revision AS publishedRevision,
    t.lock_version AS lockVersion,t.updated_at AS updatedAt,json_extract(r.document_json,'$.title') AS title
    FROM tournaments t JOIN tournament_revisions r ON r.tournament_id=t.id AND r.revision=t.draft_revision
    ORDER BY t.updated_at DESC,t.id LIMIT 51 OFFSET ?`,offset).all();
  return {items:results.slice(0,50),nextOffset:results.length>50?offset+50:null};
}

export async function getPublished(db,slug) {
  const row=await sql(db,`SELECT t.id,t.slug,t.published_revision,t.published_at,r.document_json
    FROM tournaments t JOIN tournament_revisions r ON r.tournament_id=t.id AND r.revision=t.published_revision
    WHERE t.slug=?`,slug).first();
  if (!row) throw new HttpError(404,'公開中の大会が見つかりません');
  return {id:row.id,slug:row.slug,revision:row.published_revision,publishedAt:row.published_at,document:JSON.parse(row.document_json)};
}

export async function replay(db,mutationId,hash,actorId,action,tournamentId) {
  const event=await sql(db,'SELECT * FROM audit_events WHERE mutation_id=?',mutationId).first();
  if (!event) return null;
  if (event.request_hash!==hash||event.actor_id!==actorId||event.action!==action||(tournamentId&&event.tournament_id!==tournamentId)) {
    throw new HttpError(409,'同じ操作IDを異なる操作に使用できません');
  }
  return {...await getTournament(db,event.tournament_id),replayed:true};
}

export async function createTournamentRecord(db,operator,document,mutationId,hash) {
  const prior=await replay(db,mutationId,hash,operator.id,'create');
  if (prior) return prior;
  const id=crypto.randomUUID(),slug=crypto.randomUUID().replaceAll('-',''),now=time();
  try {
    await db.batch([
      sql(db,`INSERT INTO tournaments(id,slug,draft_revision,lock_version,last_mutation_id,created_by,created_at,updated_at)
        VALUES(?,?,1,1,?,?,?,?)`,id,slug,mutationId,operator.id,now,now),
      sql(db,`INSERT INTO tournament_revisions(tournament_id,revision,document_json,mutation_id,created_by,created_at)
        VALUES(?,1,?,?,?,?)`,id,JSON.stringify(document),mutationId,operator.id,now),
      sql(db,`INSERT INTO audit_events(id,tournament_id,actor_id,action,revision,mutation_id,request_hash,result_lock_version,created_at)
        VALUES(?,?,?,'create',1,?,?,1,?)`,crypto.randomUUID(),id,operator.id,mutationId,hash,now),
    ]);
  } catch(error) {
    const duplicate=await replay(db,mutationId,hash,operator.id,'create');
    if (duplicate) return duplicate;
    throw error;
  }
  return getTournament(db,id);
}

export async function saveDraft(db,operator,current,document,expected,mutationId,hash) {
  const now=time(),revision=current.draftRevision+1;
  let batch;
  try {
    batch=await db.batch([
      sql(db,`INSERT INTO tournament_revisions(tournament_id,revision,document_json,mutation_id,created_by,created_at)
        SELECT id,?,?,?, ?,? FROM tournaments WHERE id=? AND lock_version=?`,revision,JSON.stringify(document),mutationId,operator.id,now,current.id,expected),
      sql(db,`UPDATE tournaments SET draft_revision=?,lock_version=lock_version+1,last_mutation_id=?,updated_at=?
        WHERE id=? AND lock_version=? AND EXISTS(SELECT 1 FROM tournament_revisions WHERE tournament_id=? AND mutation_id=?)`,revision,mutationId,now,current.id,expected,current.id,mutationId),
      auditStatement(db,operator.id,current.id,'save',revision,mutationId,hash,now),
    ]);
  } catch(error) {
    const duplicate=await replay(db,mutationId,hash,operator.id,'save',current.id);
    if (duplicate) return duplicate;
    throw error;
  }
  if (!batch[0].meta.changes) throw new HttpError(409,'別の更新が先に行われました。未保存の内容を確認して再読込してください');
  return getTournament(db,current.id);
}

function auditStatement(db,actor,id,action,revision,mutationId,hash,now) {
  return sql(db,`INSERT INTO audit_events(id,tournament_id,actor_id,action,revision,mutation_id,request_hash,result_lock_version,created_at)
    SELECT ?,id,?,?,?,?,?,lock_version,? FROM tournaments WHERE id=? AND last_mutation_id=?`,
  crypto.randomUUID(),actor,action,revision,mutationId,hash,now,id,mutationId);
}

export async function publishRecord(db,operator,current,target,expected,mutationId,hash) {
  const now=time(),action=target===null?'unpublish':'publish';
  const result=await db.batch([
    sql(db,`UPDATE tournaments SET published_revision=?,published_at=?,updated_at=?,lock_version=lock_version+1,last_mutation_id=?
      WHERE id=? AND lock_version=?`,target,target===null?null:now,now,mutationId,current.id,expected),
    auditStatement(db,operator.id,current.id,action,target,mutationId,hash,now),
  ]).catch(async error=>{
    const duplicate=await replay(db,mutationId,hash,operator.id,action,current.id);
    if (duplicate) return {duplicate};
    throw error;
  });
  if (result.duplicate) return result.duplicate;
  if (!result[0].meta.changes) throw new HttpError(409,'別の更新が先に行われました。再読込して確認してください');
  return getTournament(db,current.id);
}

export async function cleanup(db) {
  await db.batch([
    sql(db,`DELETE FROM tournament_revisions WHERE created_at < ? AND NOT EXISTS(
      SELECT 1 FROM tournaments t WHERE t.id=tournament_id AND (t.draft_revision=revision OR t.published_revision=revision))`,new Date(Date.now()-7*86400_000).toISOString()),
    sql(db,'DELETE FROM audit_events WHERE created_at < ?',new Date(Date.now()-90*86400_000).toISOString()),
  ]);
}
