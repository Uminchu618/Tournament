import {authenticate} from './auth.js';
import {HttpError} from './errors.js';
import {emptyDocument,documentContent,prepareChange,validateForPublication} from './model.js';
import {requestHash,getTournament,listTournaments,getPublished,replay,createTournamentRecord,saveDraft,publishRecord,cleanup} from './repository.js';

const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Cache-Control':'no-store'};
const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8',...extra}});

async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415,'JSONで送信してください');
  if (Number(request.headers.get('content-length'))>262144) throw new HttpError(413,'送信データが大きすぎます');
  const reader=request.body?.getReader();
  if (!reader) throw new HttpError(400,'JSONの形式が正しくありません');
  const chunks=[];let length=0;
  while (true) {const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>262144){await reader.cancel();throw new HttpError(413,'送信データが大きすぎます');}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  let body;
  try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch {throw new HttpError(400,'JSONの形式が正しくありません');}
  if (!body||typeof body!=='object'||Array.isArray(body)) throw new HttpError(400,'JSONオブジェクトで送信してください');
  return body;
}

function checkWrite(request) {
  const origin=request.headers.get('origin');
  if (!origin||origin!==new URL(request.url).origin) throw new HttpError(403,'同じサイトから操作してください');
  if (request.headers.get('sec-fetch-site')==='cross-site') throw new HttpError(403,'別のサイトからの操作は受け付けません');
}
const mutation=body=>{
  if (typeof body.mutationId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(body.mutationId)) throw new HttpError(400,'操作IDを確認してください');
  return body.mutationId;
};
const checkVersion=(body,current)=>{
  if (!Number.isSafeInteger(body.expectedLockVersion)||body.expectedLockVersion<1) throw new HttpError(400,'大会の版番号を確認してください');
  if (body.expectedLockVersion!==current.lockVersion) throw new HttpError(409,'別の更新が先に行われました。未保存の内容を確認して再読込してください');
};

async function api(request,env,url) {
  const path=url.pathname;
  if (path==='/api/health'&&request.method==='GET') return json({ok:true});
  if (path==='/api/config'&&request.method==='GET') return json({pollSeconds:Math.max(10,Number(env.PUBLIC_POLL_SECONDS)||300)});
  const publicMatch=/^\/api\/public\/tournaments\/([a-zA-Z0-9_-]{16,100})$/.exec(path);
  if (publicMatch&&request.method==='GET') {
    const published=await getPublished(env.DB,publicMatch[1]);
    const etag=`"${published.id}:${published.revision}"`;
    const cache={'Cache-Control':'no-cache',ETag:etag};
    if (request.headers.get('if-none-match')?.split(',').map(x=>x.trim().replace(/^W\//,'')).includes(etag)) return new Response(null,{status:304,headers:{...headers,...cache}});
    return json(published,200,cache);
  }
  if (!path.startsWith('/api/admin/')) throw new HttpError(404,'見つかりません');
  const operator=await authenticate(request,env);
  if (path==='/api/admin/me'&&request.method==='GET') return json(operator);
  if (path==='/api/admin/tournaments') {
    if (request.method==='GET') {
      const offset=Number(url.searchParams.get('offset')??0);
      if (!Number.isSafeInteger(offset)||offset<0||offset>1_000_000) throw new HttpError(400,'一覧の位置を確認してください');
      return json(await listTournaments(env.DB,offset));
    }
    if (request.method==='POST') {
      checkWrite(request);const body=await readBody(request),mid=mutation(body),hash=await requestHash(body);
      return json(await createTournamentRecord(env.DB,operator,documentContent(body.document??emptyDocument()),mid,hash),201);
    }
  }
  const route=/^\/api\/admin\/tournaments\/([0-9a-f-]{36})(?:\/(draft|publish|unpublish))?$/.exec(path);
  if (!route) throw new HttpError(404,'見つかりません');
  const [,id,action]=route;
  if (!action&&request.method==='GET') return json(await getTournament(env.DB,id));
  if (!action) throw new HttpError(405,'この操作は利用できません');
  if ((action==='draft'&&request.method!=='PUT')||(action!=='draft'&&request.method!=='POST')) throw new HttpError(405,'この操作は利用できません');
  checkWrite(request);const body=await readBody(request),mid=mutation(body),hash=await requestHash(body);
  const operation=action==='draft'?'save':action;
  const prior=await replay(env.DB,mid,hash,operator.id,operation,id);
  if (prior) return json(prior);
  const current=await getTournament(env.DB,id);checkVersion(body,current);
  if (action==='draft') {
    const change=prepareChange(current.document,body.document);
    const acknowledged=new Set(Array.isArray(body.acknowledgedMatches)?body.acknowledgedMatches:[]);
    if (change.affectedMatches.some(x=>!acknowledged.has(x))) throw new HttpError(409,'変更により取り消す試合情報を確認してください',{code:'CONFIRMATION_REQUIRED',affectedMatches:change.affectedMatches});
    return json(await saveDraft(env.DB,operator,current,change.document,body.expectedLockVersion,mid,hash));
  }
  if (action==='publish') {
    if (body.targetRevision!==current.draftRevision) throw new HttpError(409,'公開する保存版が変更されています');
    validateForPublication(current.document);
    return json(await publishRecord(env.DB,operator,current,current.draftRevision,body.expectedLockVersion,mid,hash));
  }
  if (action==='unpublish') return json(await publishRecord(env.DB,operator,current,null,body.expectedLockVersion,mid,hash));
  throw new HttpError(404,'見つかりません');
}

export default {
  async fetch(request,env) {
    try {
      const url=new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await api(request,env,url);
      if (/^\/admin(?:\/|$)/.test(url.pathname)) await authenticate(request,env);
      if (request.method!=='GET'&&request.method!=='HEAD') return json({error:'この操作は利用できません'},405);
      // The assets service canonicalizes /index.html to /. Fetch / internally so
      // the browser keeps the original management/shared URL.
      const target=/^\/(?:admin(?:\/.*)?|t\/[a-zA-Z0-9_-]+)$/.test(url.pathname)?new URL('/',url):url;
      const response=await env.ASSETS.fetch(new Request(target,request));
      const result=new Response(response.body,response);
      for (const [key,value] of Object.entries(headers)) result.headers.set(key,value);
      if(url.pathname.startsWith('/assets/fonts/'))result.headers.set('Cache-Control','public, max-age=86400');
      result.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      return result;
    } catch(error) {
      if (error instanceof HttpError) return json({error:error.message,...error.details},error.status);
      if (/^(大会|参加者|組合せ|同じ|存在しない|試合|無効な|すべて|公開)/.test(error.message)) return json({error:error.message},400);
      console.error(JSON.stringify({event:'request_failed',type:error.name}));
      return json({error:'サーバーでエラーが発生しました。時間をおいて再試行してください'},503);
    }
  },
  async scheduled(_event,env,ctx) {ctx.waitUntil(cleanup(env.DB));},
};
