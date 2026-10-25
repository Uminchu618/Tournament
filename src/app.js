import {createTournament,documentScenes,renderSVG} from './engine.js';
import {emptyDocument,slotCapacity,documentContent,prepareChange,MAX_ENTRANTS} from './model.js';
import {loadFont,createPDF} from './pdf.js';

const $=selector=>document.querySelector(selector);
const admin=location.pathname.startsWith('/admin');
const tournamentId=/^\/admin\/tournaments\/([0-9a-f-]{36})$/.exec(location.pathname)?.[1];
const publicSlug=/^\/t\/([a-zA-Z0-9_-]+)$/.exec(location.pathname)?.[1];
let data=emptyDocument(),record=null,dirty=false,busy=false,fontData=null,nextOffset=null;
let publicETag='',pollSeconds=300,pollTimer=null,lastRequest=null,publicFetching=false;
const acknowledged=new Set();

function notify(message,success=false){const box=$('#message');box.textContent=message;box.classList.toggle('success',success);box.hidden=!message;}
function element(tag,value,className){const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
function complete(){return data.participants.length>=2&&data.slots.filter(Boolean).length===data.participants.length;}
function markDirty(){dirty=true;lastRequest=null;updateActions();}
function updateActions(){
  if(!admin||!record)return;
  $('#saveState').textContent=dirty?'未保存の変更があります':`保存版 ${record.draftRevision} ／ ${record.publishedRevision?`公開版 ${record.publishedRevision}`:'未公開'}`;
  $('#saveButton').disabled=busy||!dirty;
  $('#publishButton').disabled=busy||dirty||!complete();
  $('#unpublishButton').disabled=busy||!record.publishedRevision;
  $('#pdfButton').disabled=busy||!complete()||dirty;
  $('#publicLink').href=`/t/${record.slug}`;$('#publicLink').hidden=!record.publishedRevision;
}

async function request(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',...options});
  let body;try{body=await response.json();}catch{throw new Error('通信に失敗しました。ログイン状態を確認してください');}
  if(!response.ok){const error=new Error(body.error??'通信に失敗しました');error.status=response.status;error.details=body;throw error;}
  return body;
}
const apiPath=()=>`/api/admin/tournaments/${record.id}`;

function applyChange(input){
  try{
    const change=prepareChange(data,input);
    if(change.affectedMatches.length&&!confirm(`次の試合の勝者・得点・注記などを取り消します。\n${change.affectedMatches.join('、')}\n変更を続けますか？`))return false;
    change.affectedMatches.forEach(id=>acknowledged.add(id));
    data=change.document;markDirty();render();return true;
  }catch(error){notify(error.message);return false;}
}

function renderParticipants(){
  $('#entrantCount').textContent=`${data.participants.length} / ${MAX_ENTRANTS}`;
  const container=$('#participantList');container.replaceChildren();
  data.participants.forEach((entry,index)=>{
    const row=element('div','','participant-row');row.append(element('span',String(index+1)));
    const input=document.createElement('input');input.value=entry.name;input.maxLength=100;input.setAttribute('aria-label',`${index+1}番目の参加者名`);
    input.addEventListener('change',()=>{const value=input.value.trim();if(!value){input.value=entry.name;notify('参加者名を入力してください');return;}entry.name=value;markDirty();renderPreview();renderMatches();});
    const remove=element('button','削除');remove.type='button';remove.setAttribute('aria-label',`${entry.name}を削除`);
    remove.addEventListener('click',()=>{const next=structuredClone(data);next.participants.splice(index,1);next.slots=next.slots.map(id=>id===entry.id?null:id).slice(0,slotCapacity(next.participants.length));applyChange(next);});
    row.append(input,remove);container.append(row);
  });
}

function renderSlots(){
  $('#slotHelp').textContent=`${data.slots.length}枠中 ${data.slots.filter(Boolean).length}枠を指定済み。空欄はBYEとして扱います。`;
  const container=$('#slotList');container.replaceChildren();
  for(let index=0;index<data.slots.length;index+=2){
    const card=element('div','','slot-card');card.append(element('strong',`第1回戦・${index/2+1}組`));
    const pair=element('div','','slot-pair');
    for(let offset=0;offset<2;offset++){
      const slot=index+offset,label=element('label',`枠 ${slot+1}`),select=document.createElement('select');select.setAttribute('aria-label',`枠 ${slot+1}の参加者`);
      const blank=element('option','空欄（BYE）');blank.value='';select.append(blank);
      for(const entry of data.participants){const option=element('option',entry.name);option.value=entry.id;select.append(option);}
      select.value=data.slots[slot]??'';
      select.addEventListener('change',()=>{const next=structuredClone(data),chosen=select.value||null,former=next.slots[slot],other=chosen?next.slots.indexOf(chosen):-1;if(other>=0&&other!==slot)next.slots[other]=former;next.slots[slot]=chosen;if(!applyChange(next))select.value=former??'';});
      label.append(select);pair.append(label);
    }
    card.append(pair);container.append(card);
  }
}

function detailField(fields,id,key,label,type='text',disabled=false){
  const wrapper=element('label',label),input=document.createElement(type==='textarea'?'textarea':'input');
  if(type!=='textarea')input.type=type;
  input.setAttribute('aria-label',`${id} ${label}`);input.disabled=disabled;
  const value=data.matchDetails[id]?.[key];
  input.value=key==='scheduledAt'&&value?new Date(Date.parse(value)+9*3600_000).toISOString().slice(0,16):value??'';
  if(type==='number'){input.min='0';input.max='999999';input.step='1';}
  if(key==='venue')input.maxLength=100;if(key==='notes')input.maxLength=1000;
  input.addEventListener('change',()=>{
    const detail=data.matchDetails[id]??={scoreA:null,scoreB:null,scheduledAt:'',venue:'',notes:''};
    detail[key]=type==='number'?(input.value===''?null:Number(input.value)):key==='scheduledAt'?(input.value?`${input.value}:00+09:00`:''):input.value;
    markDirty();renderPreview();
  });
  wrapper.append(input);fields.append(wrapper);
}

function renderMatches(){
  const container=$('#matchList');container.replaceChildren();
  if(!complete()){container.append(element('p','全参加者を配置すると試合を編集できます。','help'));return;}
  const tournament=createTournament(data.participants,data.results,data.slots);
  for(const match of tournament.matches){
    const card=element('div','','match-card');card.append(element('strong',`第${match.depth}回戦・${match.id}`));
    const players=match.children.map(c=>c.winner),ready=players.every(Boolean)&&match.children.every(c=>c.resolved);
    card.append(element('p',`${players[0]?.name??'勝者待ち'} 対 ${players[1]?.name??'勝者待ち'}`,'match-players'));
    const label=element('label','勝者'),select=document.createElement('select');select.setAttribute('aria-label',`${match.id}の勝者`);
    const blank=element('option','勝者未確定');blank.value='';select.append(blank);
    for(const entry of players.filter(Boolean)){const option=element('option',entry.name);option.value=entry.id;select.append(option);}
    select.value=data.results[match.id]??'';select.disabled=!ready;
    select.addEventListener('change',()=>{const next=structuredClone(data);if(select.value)next.results[match.id]=select.value;else delete next.results[match.id];if(!applyChange(next))select.value=data.results[match.id]??'';});
    label.append(select);card.append(label);
    const fields=element('div','','match-fields'),scores=element('div','','score-pair');
    detailField(scores,match.id,'scoreA','左の得点','number',!ready);detailField(scores,match.id,'scoreB','右の得点','number',!ready);fields.append(scores);
    detailField(fields,match.id,'scheduledAt','開始日時（日本時間）','datetime-local');detailField(fields,match.id,'venue','会場');detailField(fields,match.id,'notes','試合の注記','textarea');
    card.append(fields);container.append(card);
  }
}

function getScenes(){return documentScenes(data,{measure:fontData?.measure,label:admin?(dirty?'未保存の下書き':`下書き / 保存版 ${record?.draftRevision??''}`):`公開版 ${record?.revision??''}`});}
function renderPreview(){
  const pages=$('#pages'),empty=$('#previewEmpty');pages.replaceChildren();
  if(!complete()){empty.hidden=false;empty.textContent=admin?'参加者を2組以上登録し、全員を枠に割り当ててください。':'公開中の大会が見つかりません。';$('#pageSummary').textContent='';$('#printButton').disabled=true;$('#pdfButton').disabled=true;return;}
  try{
    const scenes=getScenes();empty.hidden=true;
    scenes.forEach((scene,index)=>{const page=element('section','','sheet');page.setAttribute('aria-label',`${index+1}ページ`);page.innerHTML=renderSVG(scene);pages.append(page);});
    $('#pageSummary').textContent=`${data.participants.length}組・${scenes.length}ページ・A4縦${fontData?'':' ／ フォント読込中'}`;
    $('#printButton').disabled=false;$('#pdfButton').disabled=busy||admin&&dirty||!fontData;
  }catch(error){empty.hidden=false;empty.textContent=error.message;$('#printButton').disabled=true;$('#pdfButton').disabled=true;}
}

function render(){
  $('#appView').hidden=false;$('#appView').classList.toggle('public-only',!admin);$('#mobileSections').hidden=!admin;$('#editor').hidden=!admin;
  for(const selector of ['#saveButton','#publishButton','#unpublishButton','#reloadButton','#logoutButton'])$(selector).hidden=!admin;
  $('#refreshButton').hidden=admin;$('#capacity').disabled=!admin;
  $('#heroTitle').textContent=data.title||'大会組合せ表';$('#heroMeta').textContent=[data.date,data.notes].filter(Boolean).join(' ｜ ');
  $('#heroEyebrow').textContent=admin?'ORGANIZER WORKSPACE':'TOURNAMENT BOARD';$('#capacity').value=data.layoutSettings.slotsPerPage;
  if(admin){$('#title').value=data.title;$('#date').value=data.date;$('#notes').value=data.notes;renderParticipants();renderSlots();renderMatches();updateActions();}
  renderPreview();
}

function loadRecord(value){record=value;data=structuredClone(value.document);dirty=false;acknowledged.clear();lastRequest=null;render();}
async function loadList(append=false){
  if(!append){$('#tournamentList').replaceChildren();nextOffset=0;}
  const list=await request(`/api/admin/tournaments?offset=${nextOffset??0}`);
  for(const item of list.items){
    const card=element('article','','tournament-card'),link=element('a',item.title||'名称未設定の大会');link.href=`/admin/tournaments/${item.id}`;
    const heading=element('h2','');heading.append(link);card.append(heading,element('p',`保存版 ${item.draftRevision} ／ ${item.publishedRevision?`公開版 ${item.publishedRevision}`:'未公開'}`,'help'));$('#tournamentList').append(card);
  }
  nextOffset=list.nextOffset;$('#moreButton').hidden=nextOffset===null;
  if(!append&&!list.items.length)$('#tournamentList').append(element('p','まだ大会がありません。「大会を作成」から始めてください。','help'));
}

async function updatePublic(manual=false){
  if(!publicSlug)return;
  if(busy||publicFetching){schedulePoll();return;}
  publicFetching=true;
  try{
    const response=await fetch(`/api/public/tournaments/${publicSlug}`,{headers:publicETag?{'If-None-Match':publicETag}:{}});
    if(response.status===404){record=null;data=emptyDocument();publicETag='';render();notify('現在、この大会は公開されていません。');return;}
    if(response.status!==304){if(!response.ok)throw new Error('公開データを取得できませんでした');record=await response.json();data=record.document;publicETag=response.headers.get('etag')??'';render();}
    $('#saveState').textContent=`最終確認 ${new Date().toLocaleTimeString('ja-JP')} ／ ${Math.round(pollSeconds/60)}分ごとに確認`;
    if(manual)notify('最新の公開内容を確認しました',true);
  }catch(error){notify(`${error.message}。表示中の内容は最新ではない可能性があります。`);}
  finally{publicFetching=false;schedulePoll();}
}
function schedulePoll(){clearTimeout(pollTimer);if(!document.hidden&&publicSlug)pollTimer=setTimeout(()=>updatePublic(),pollSeconds*1000);}
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);if(!document.hidden)updatePublic();});

for(const [selector,key] of [['#title','title'],['#date','date'],['#notes','notes']])$(selector).addEventListener('input',event=>{data[key]=event.target.value;markDirty();$('#heroTitle').textContent=data.title||'大会組合せ表';$('#heroMeta').textContent=[data.date,data.notes].filter(Boolean).join(' ｜ ');renderPreview();});
$('#addParticipants').addEventListener('click',()=>{
  const names=$('#newParticipants').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!names.length)return notify('参加者名を入力してください');
  if(data.participants.length+names.length>MAX_ENTRANTS)return notify('参加者は最大64組です');
  const next=structuredClone(data);for(const name of names)next.participants.push({id:`p_${crypto.randomUUID().replaceAll('-','')}`,name});
  while(next.slots.length<slotCapacity(next.participants.length))next.slots.push(null);
  if(applyChange(next))$('#newParticipants').value='';
});
$('#capacity').addEventListener('change',()=>{data.layoutSettings.slotsPerPage=Number($('#capacity').value);markDirty();renderPreview();});
$('#saveButton').addEventListener('click',async()=>{
  if(busy)return;
  try{
    const normalized=documentContent(data);
    const body=lastRequest??={document:normalized,expectedLockVersion:record.lockVersion,mutationId:crypto.randomUUID(),acknowledgedMatches:[...acknowledged]};
    busy=true;updateActions();notify('');
    const saved=await request(`${apiPath()}/draft`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    loadRecord(saved);notify('下書きを保存しました。公開内容は変わりません。',true);
  }catch(error){notify(error.message);if(error.details?.code==='CONFIRMATION_REQUIRED'&&confirm(`${error.message}\n${error.details.affectedMatches.join('、')}\n取り消して保存しますか？`)){error.details.affectedMatches.forEach(id=>acknowledged.add(id));lastRequest=null;setTimeout(()=>$('#saveButton').click());}}
  finally{busy=false;updateActions();renderPreview();}
});
async function publish(action){
  if(busy||dirty)return notify('先に下書きを保存してください');
  if(!confirm(action==='publish'?'保存済みの版を共有URLへ公開しますか？':'大会の公開を停止しますか？'))return;
  try{busy=true;updateActions();const body={expectedLockVersion:record.lockVersion,targetRevision:record.draftRevision,mutationId:crypto.randomUUID()};loadRecord(await request(`${apiPath()}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));notify(action==='publish'?'公開しました':'公開を停止しました',true);}catch(error){notify(error.message);}finally{busy=false;updateActions();renderPreview();}
}
$('#publishButton').addEventListener('click',()=>publish('publish'));$('#unpublishButton').addEventListener('click',()=>publish('unpublish'));
$('#reloadButton').addEventListener('click',async()=>{if(dirty&&!confirm('未保存の変更を破棄して保存版を再読込しますか？'))return;try{loadRecord(await request(apiPath()));notify('保存版を読み込みました',true);}catch(error){notify(error.message);}});
$('#refreshButton').addEventListener('click',()=>updatePublic(true));
$('#createButton').addEventListener('click',async()=>{if(busy)return;try{busy=true;$('#createButton').disabled=true;const created=await request('/api/admin/tournaments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mutationId:crypto.randomUUID()})});location.assign(`/admin/tournaments/${created.id}`);}catch(error){notify(error.message);busy=false;$('#createButton').disabled=false;}});
$('#moreButton').addEventListener('click',()=>loadList(true).catch(error=>notify(error.message)));
$('#logoutButton').addEventListener('click',()=>{if(!dirty||confirm('未保存の変更があります。ログアウトしますか？')){dirty=false;location.assign('/cdn-cgi/access/logout');}});
function setMobileView(view){$('#workspace').dataset.mobileView=view;$('#showEditor').setAttribute('aria-pressed',String(view==='edit'));$('#showPreview').setAttribute('aria-pressed',String(view==='preview'));}
$('#showEditor').addEventListener('click',()=>setMobileView('edit'));$('#showPreview').addEventListener('click',()=>setMobileView('preview'));
$('#zoomButton').addEventListener('click',()=>{const actual=$('#previewPanel').dataset.zoom!=='actual';$('#previewPanel').dataset.zoom=actual?'actual':'fit';$('#zoomButton').setAttribute('aria-pressed',String(actual));$('#zoomButton').textContent=actual?'全体を表示':'拡大して見る';});
$('#printButton').addEventListener('click',()=>window.print());
$('#pdfButton').addEventListener('click',async()=>{
  if(busy||dirty||!complete())return;
  const snapshot=structuredClone(data),revision=admin?record.draftRevision:record.revision;
  try{busy=true;$('#pdfButton').disabled=true;notify('PDFを生成しています…');
    const scenes=documentScenes(snapshot,{measure:(await loadFont()).measure,label:`${admin?'下書き':'公開版'} ${revision}`});
    const bytes=await createPDF(scenes,{title:snapshot.title,revision});
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=`${snapshot.title.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')}_v${revision}.pdf`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);notify('PDFを生成しました',true);
  }catch(error){notify(error.message);}finally{busy=false;updateActions();renderPreview();}
});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});

async function start(){
  try{
    ({pollSeconds}=await request('/api/config'));
    if(admin){const me=await request('/api/admin/me');if(tournamentId)loadRecord(await request(`/api/admin/tournaments/${tournamentId}`));else{$('#listView').hidden=false;$('#operatorName').textContent=me.email;await loadList();}}
    else if(publicSlug)await updatePublic();else $('#homeView').hidden=false;
    fontData=await loadFont();if(record)renderPreview();
  }catch(error){notify(error.message);}
}
start();
