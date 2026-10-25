import http from 'node:http';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {emptyDocument,validateDocument} from './src/model.js';

const root=dirname(fileURLToPath(import.meta.url));
const staticFiles=new Map([
  ['/','index.html'],['/admin','index.html'],['/src/app.js','src/app.js'],
  ['/src/engine.js','src/engine.js'],['/src/model.js','src/model.js'],
  ['/styles.css','styles.css'],
]);
const mime=path=>path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';

function send(res,status,body,headers={}) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
  res.end(JSON.stringify(body));
}

async function readJSON(req) {
  let text='';
  for await (const chunk of req) {
    text+=chunk;
    if (text.length>256_000) throw new Error('送信データが大きすぎます');
  }
  try {return JSON.parse(text);} catch {throw new Error('JSONの形式が正しくありません');}
}

function sameOrigin(req) {
  const origin=req.headers.origin;
  if (!origin) return true;
  try {return new URL(origin).host===req.headers.host;} catch {return false;}
}

export async function createApp({password=process.env.ADMIN_PASSWORD,dataFile=process.env.DATA_FILE ?? join(root,'data','tournament.json'),production=process.env.NODE_ENV==='production'}={}) {
  if (!password || password.length<12) throw new Error('ADMIN_PASSWORDに12文字以上のパスワードを設定してください');
  let state=emptyDocument();
  try {
    const stored=JSON.parse(await readFile(dataFile,'utf8'));
    state={...validateDocument(stored),version:stored.version,updatedAt:stored.updatedAt};
    if (!Number.isSafeInteger(state.version) || state.version<0) throw new Error('保存データの版数が不正です');
  } catch(error) {
    if (error.code!=='ENOENT') throw error;
  }
  const sessions=new Map();
  const failures=new Map();
  let saveQueue=Promise.resolve();
  const cookieName='tournament_session';
  const cookie=token=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${production?'; Secure':''}`;
  const authenticated=req=>{
    const token=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    const expiry=sessions.get(token);
    if (!expiry || expiry<Date.now()) {sessions.delete(token);return false;}
    return true;
  };

  const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    try {
      if (req.method==='GET' && path==='/api/public') {
        return send(res,200,state.published?state:null);
      }
      if (req.method==='GET' && path==='/api/admin/session') return send(res,200,{authenticated:authenticated(req)});
      if (req.method==='GET' && path==='/api/admin/tournament') {
        return authenticated(req)?send(res,200,state):send(res,401,{error:'ログインが必要です'});
      }
      if (req.method==='POST' && path.startsWith('/api/admin/')) {
        if (!sameOrigin(req)) return send(res,403,{error:'別のサイトからの操作は受け付けません'});
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res,415,{error:'JSONで送信してください'});
        const body=await readJSON(req);
        if (path==='/api/admin/login') {
          const address=req.socket.remoteAddress??'unknown';
          const previous=failures.get(address);
          const failed=previous && previous.until>Date.now()?previous:{count:0,until:0};
          if (failed.count>=5 && failed.until>Date.now()) return send(res,429,{error:'時間をおいて再試行してください'});
          const supplied=Buffer.from(String(body.password??''));
          const expected=Buffer.from(password);
          const valid=supplied.length===expected.length && timingSafeEqual(supplied,expected);
          if (!valid) {
            failures.set(address,{count:failed.count+1,until:Date.now()+15*60_000});
            return send(res,401,{error:'パスワードが違います'});
          }
          failures.delete(address);
          const token=randomBytes(32).toString('hex');
          sessions.set(token,Date.now()+12*60*60_000);
          return send(res,200,{ok:true},{'Set-Cookie':cookie(token)});
        }
        if (!authenticated(req)) return send(res,401,{error:'ログインが必要です'});
        if (path==='/api/admin/logout') {
          const token=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
          sessions.delete(token);
          return send(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production?'; Secure':''}`});
        }
        if (path==='/api/admin/save') {
          const work=async()=>{
            if (!Number.isSafeInteger(body.version) || body.version!==state.version) return {status:409,body:{error:'別の保存が先に行われました。再読込して確認してください'}};
            const document=validateDocument(body);
            const next={...document,version:state.version+1,updatedAt:new Date().toISOString()};
            await mkdir(dirname(dataFile),{recursive:true});
            const temp=`${dataFile}.${randomUUID()}.tmp`;
            await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600});
            await rename(temp,dataFile);
            state=next;
            return {status:200,body:next};
          };
          const result=await (saveQueue=saveQueue.catch(()=>{}).then(work));
          return send(res,result.status,result.body);
        }
      }
      if (req.method==='GET' && staticFiles.has(path)) {
        const name=staticFiles.get(path);
        res.writeHead(200,{'Content-Type':mime(name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(await readFile(join(root,name)));
      }
      return send(res,404,{error:'見つかりません'});
    } catch(error) {
      const clientError=/^(大会|参加者|組合せ|同じ|存在しない|試合|無効な|すべて|送信|JSON|公開)/.test(error.message);
      return send(res,clientError?400:500,{error:clientError?error.message:'サーバーでエラーが発生しました'});
    }
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const server=await createApp();
  const port=Number(process.env.PORT ?? 8080);
  const host=process.env.HOST ?? '127.0.0.1';
  server.listen(port,host,()=>console.log(`Tournament: http://${host}:${port}`));
}
