import {test,expect} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';

const ids=[];
const sample=n=>({title:`E2E大会 ${crypto.randomUUID().slice(0,8)}`,date:'2026年11月1日',notes:'日本語の注記を含む大会',participants:Array.from({length:n},(_,i)=>({id:`p${i+1}`,name:`参加者${i+1}`})),slots:Array.from({length:2**Math.ceil(Math.log2(n))},(_,i)=>i<n?`p${i+1}`:null),results:{},matchDetails:{},layoutSettings:{slotsPerPage:16}});
async function api(request,path,body,method='POST'){
  const origin=process.env.E2E_BASE_URL??'http://127.0.0.1:8787';
  const response=await request.fetch(path,{method,headers:{Origin:origin,'Content-Type':'application/json'},data:body});
  return {status:response.status(),body:await response.json()};
}
async function create(request,n){
  const result=await api(request,'/api/admin/tournaments',{mutationId:crypto.randomUUID(),document:sample(n)});expect(result.status).toBe(201);ids.push(result.body.id);return result.body;
}
async function publish(request,record){return api(request,`/api/admin/tournaments/${record.id}/publish`,{mutationId:crypto.randomUUID(),expectedLockVersion:record.lockVersion,targetRevision:record.draftRevision});}
test.afterAll(async()=>{await mkdir('.artifacts',{recursive:true});await writeFile('.artifacts/e2e-created.json',JSON.stringify(ids));});

test('画面で大会作成、名簿順の配置と手動調整、得点・会場入力、公開、直接PDFを出力する',async({page,request})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/admin');
  await page.getByRole('button',{name:'大会を作成',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/tournaments\//);
  const id=new URL(page.url()).pathname.split('/').at(-1);ids.push(id);
  await page.getByLabel('大会名',{exact:false}).fill('E2E秋季大会');
  await page.locator('#date').fill('2026年11月1日');
  await page.locator('#notes').fill('得点と日時の保存を確認');
  await page.locator('#newParticipants').fill('城南中学校 田中圭太\n城北中学校 佐藤健太\n福岡中学校 鈴木悠斗\n札幌中学校 山田太郎');
  await page.getByRole('button',{name:'追加して組合せを作成',exact:true}).click();
  const participants=(await (await request.get(`/api/admin/tournaments/${id}`)).json()).document.participants;
  expect(participants).toHaveLength(0);
  const options=await page.getByRole('combobox',{name:'枠 1の参加者',exact:true}).locator('option').evaluateAll(nodes=>nodes.filter(x=>x.value).map(x=>x.value));
  for(let i=0;i<4;i++)await expect(page.getByRole('combobox',{name:`枠 ${i+1}の参加者`,exact:true})).toHaveValue(options[i]);
  await expect(page.locator('#pendingList')).toContainText('全員の配置が完了');
  await page.getByRole('combobox',{name:'枠 1の参加者',exact:true}).selectOption('');
  await expect(page.locator('#pendingList')).toContainText('城南中学校 田中圭太');
  await page.getByRole('button',{name:'未配置だけ空き枠へ入れる',exact:true}).click();
  await page.getByRole('button',{name:'3 試合結果',exact:true}).click();
  await page.getByRole('spinbutton',{name:'R1-M1 左の得点',exact:true}).fill('3');
  await page.getByRole('spinbutton',{name:'R1-M1 右の得点',exact:true}).fill('2');
  await page.getByLabel('R1-M1 開始日時（日本時間）',{exact:true}).fill('2026-11-01T09:00');
  await page.getByLabel('R1-M1 会場',{exact:true}).fill('第1会場');
  await page.getByLabel('R1-M1 試合の注記',{exact:true}).fill('日本語の試合注記');
  await page.getByRole('combobox',{name:'R1-M1の勝者',exact:true}).selectOption(options[0]);
  await page.getByRole('button',{name:'下書きを保存',exact:true}).click();
  await expect(page.locator('#message')).toContainText('下書きを保存しました');
  let record=await (await request.get(`/api/admin/tournaments/${id}`)).json();
  expect(record.document.divisions[0].matchDetails['R1-M1']).toMatchObject({scoreA:3,scoreB:2,venue:'第1会場',notes:'日本語の試合注記'});
  expect((await request.get(`/api/public/tournaments/${record.slug}`)).status()).toBe(404);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'公開する',exact:true}).click();
  await expect(page.locator('#message')).toContainText('公開しました');
  await expect(page.getByRole('button',{name:'PDFをダウンロード',exact:true})).toBeEnabled({timeout:60_000});
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'PDFをダウンロード',exact:true}).click();
  const download=await downloadPromise;expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const bytes=await readFile(await download.path()),pdf=await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBeGreaterThan(1);
  for(const p of pdf.getPages()){expect(p.getWidth()).toBeCloseTo(210*72/25.4,2);expect(p.getHeight()).toBeCloseTo(297*72/25.4,2);}
  await mkdir('.artifacts',{recursive:true});await writeFile('.artifacts/tournament-e2e.pdf',bytes);
  await page.screenshot({path:'.artifacts/admin-desktop.png'});
  await page.goto(`/t/${record.slug}`);await expect(page.locator('#heroTitle')).toHaveText('E2E秋季大会');
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.getByRole('button',{name:'最新に更新',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('公開版は下書きと分離され、5分ポーリングと手動更新・公開停止が働く',async({page,request})=>{
  let record=await create(request,5);record=(await publish(request,record)).body;
  await page.goto(`/t/${record.slug}`);await expect(page.locator('#heroTitle')).toHaveText(record.document.title);
  await page.clock.install();
  const changed={...record.document,title:'E2E更新後の大会'};
  const saved=await api(request,`/api/admin/tournaments/${record.id}/draft`,{mutationId:crypto.randomUUID(),expectedLockVersion:record.lockVersion,document:changed},'PUT');expect(saved.status).toBe(200);
  await page.getByRole('button',{name:'最新に更新',exact:true}).click();await expect(page.locator('#message')).toContainText('最新の公開内容を確認しました');await expect(page.locator('#heroTitle')).toHaveText(record.document.title);
  record=(await publish(request,saved.body)).body;
  await page.clock.runFor(300_100);await expect(page.locator('#heroTitle')).toHaveText('E2E更新後の大会');
  const stopped=await api(request,`/api/admin/tournaments/${record.id}/unpublish`,{mutationId:crypto.randomUUID(),expectedLockVersion:record.lockVersion});expect(stopped.status).toBe(200);
  await page.getByRole('button',{name:'最新に更新',exact:true}).click();await expect(page.locator('#pages .sheet')).toHaveCount(0);
});

test('実行中のD1で同時保存は一方だけ成功し、再送は重複しない',async({request})=>{
  const record=await create(request,4),path=`/api/admin/tournaments/${record.id}/draft`;
  const base={expectedLockVersion:record.lockVersion,document:{...record.document,title:'E2E競合テスト'}};
  const a={...base,mutationId:crypto.randomUUID()},b={...base,mutationId:crypto.randomUUID()};
  const results=await Promise.all([api(request,path,a,'PUT'),api(request,path,b,'PUT')]);
  expect(results.map(x=>x.status).sort()).toEqual([200,409]);
  const winner=results[0].status===200?a:b;
  const retry=await api(request,path,winner,'PUT');expect(retry.status).toBe(200);expect(retry.body.replayed).toBe(true);
  expect(retry.body.draftRevision).toBe(record.draftRevision+1);
});

test('64組の表と日本語PDFを生成し、スマートフォンで横はみ出しなく操作する',async({page,request})=>{
  const record=await create(request,64);expect((await publish(request,record)).status).toBe(200);
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/admin/tournaments/${record.id}`);
  await expect(page.locator('#heroTitle')).toHaveText(record.document.title);
  await page.getByRole('button',{name:'表を見る',exact:true}).click();
  await expect(page.locator('#previewPanel')).toBeVisible();
  await expect(page.getByRole('button',{name:'PDFをダウンロード',exact:true})).toBeEnabled({timeout:60_000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'PDFをダウンロード',exact:true}).click();
  const bytes=await readFile(await (await downloadPromise).path());
  const pdf=await PDFDocument.load(bytes);expect(pdf.getPageCount()).toBeGreaterThan(3);
  await writeFile('.artifacts/tournament-64-e2e.pdf',bytes);
  await page.screenshot({path:'.artifacts/admin-mobile.png'});
  await page.goto(`/t/${record.slug}`);await expect(page.locator('#pages .sheet').first()).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('秘密ファイルと一般向け大会一覧を配信しない',async({request})=>{
  for(const path of ['/.env','/wrangler.staging.json','/src/worker.js','/api/public/tournaments','/api/missing'])expect((await request.get(path)).status()).toBe(404);
  expect((await request.get('/api/config')).ok()).toBe(true);
});

test('1大会の個人戦・団体戦を切り替え、シードと名簿、結果、公開PDFを保持する',async({page,request})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/admin');await page.getByRole('button',{name:'大会を作成',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/tournaments\//);
  const id=new URL(page.url()).pathname.split('/').at(-1);ids.push(id);
  await page.getByLabel('大会名',{exact:false}).fill('秋季剣道大会');
  await page.getByLabel('部門名',{exact:false}).fill('中学生・個人戦');
  await page.locator('#newParticipants').fill('城南中学校 田中圭太\n城北中学校 佐藤健太\n田中道場 鈴木悠斗\n中央中学校 山田太郎\n城南中学校 高橋一郎');
  await page.getByRole('button',{name:'追加して組合せを作成',exact:true}).click();
  await expect(page.locator('#slotHelp')).toContainText('5組中 5組を配置済み');
  await page.getByRole('button',{name:'1 名簿',exact:true}).click();
  await page.getByLabel('1番目のシード',{exact:true}).selectOption('1');
  await page.getByLabel('2番目のシード',{exact:true}).selectOption('2');
  await expect(page.locator('#participantList')).toContainText('配置済み：枠 8');
  await page.getByRole('button',{name:'部門を追加',exact:true}).click();
  await page.getByLabel('部門名',{exact:false}).fill('小学生・団体戦');
  await page.getByLabel('種別',{exact:true}).selectOption('team');
  await expect(page.locator('#teamHelp')).toBeVisible();
  await page.locator('#newParticipants').fill('城南道場 Aチーム\n城北道場 Bチーム');
  await page.getByRole('button',{name:'追加して組合せを作成',exact:true}).click();
  await page.getByRole('button',{name:'3 試合結果',exact:true}).click();
  const teamWinner=await page.getByRole('combobox',{name:'R1-M1の勝者',exact:true}).locator('option').nth(1).getAttribute('value');
  await page.getByRole('combobox',{name:'R1-M1の勝者',exact:true}).selectOption(teamWinner);
  await page.getByRole('button',{name:'下書きを保存',exact:true}).click();
  await expect(page.locator('#message')).toContainText('下書きを保存しました');
  let record=await (await request.get(`/api/admin/tournaments/${id}`)).json();
  expect(record.document.divisions).toHaveLength(2);
  expect(record.document.divisions[0].participants[0]).toMatchObject({organization:'城南中学校',name:'田中圭太',seed:1});
  expect(record.document.divisions[0].results).toEqual({});
  expect(record.document.divisions[1].results['R1-M1']).toBe(teamWinner);
  await page.reload();
  await page.locator('#divisionTabs').getByRole('button',{name:/中学生・個人戦/}).click();
  await expect(page.locator('#pages')).toContainText('城南中学校');
  await expect(page.getByRole('button',{name:'印刷する',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'1 名簿',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'.artifacts/divisions-roster-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'2 組合せ',exact:true}).click();
  await page.screenshot({path:'.artifacts/divisions-placement-mobile.png',fullPage:true});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'公開する',exact:true}).click();
  await expect(page.locator('#message')).toContainText('公開しました');
  await page.goto(`/t/${record.slug}`);
  await expect(page.locator('#divisionTabs button')).toHaveCount(2);
  await page.locator('#divisionTabs').getByRole('button',{name:/小学生・団体戦/}).click();
  await expect(page.locator('#pages')).toContainText('城南道場 Aチーム');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(page.getByRole('button',{name:'PDFをダウンロード',exact:true})).toBeEnabled({timeout:60_000});
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'PDFをダウンロード',exact:true}).click();
  expect((await downloaded).suggestedFilename()).toContain('小学生・団体戦');
  expect(errors).toEqual([]);
});
