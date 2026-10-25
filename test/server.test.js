import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';

test('公開データと運営者の保存権限を分離する',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tournament-test-'));
  const server=await createApp({password:'a-strong-test-password',dataFile:join(directory,'data.json')});
  await new Promise(resolve=>server.listen(0,resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const first=await fetch(`${base}/api/public`);assert.equal(await first.json(),null);
    const denied=await fetch(`${base}/api/admin/tournament`);assert.equal(denied.status,401);
    const deniedSave=await fetch(`${base}/api/admin/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(deniedSave.status,401);
    const login=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'a-strong-test-password'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const body={title:'公開大会',date:'2026年',notes:'',participants:[{id:'p1',name:'東京'},{id:'p2',name:'大阪'}],slots:['p1','p2'],results:{},published:true,version:0};
    const save=await fetch(`${base}/api/admin/save`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
    assert.equal(save.status,200);
    const publicData=await (await fetch(`${base}/api/public`)).json();
    assert.equal(publicData.title,'公開大会');assert.equal(publicData.version,1);
    const conflict=await fetch(`${base}/api/admin/save`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
    assert.equal(conflict.status,409);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
