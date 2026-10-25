import {createTournament,documentScenes,renderSVG} from './engine.js';
import {emptyDocument,emptyDivision,asEvent,bracketComplete,documentContent,prepareChange,MAX_ENTRANTS,MAX_DIVISIONS} from './model.js';
import {entrantLabel,parseRoster,orderedSlots,removeEntrant} from './placement.js';
import {loadFont,createPDF} from './pdf.js';

const $=selector=>document.querySelector(selector);
const admin=location.pathname.startsWith('/admin');
const tournamentId=/^\/admin\/tournaments\/([0-9a-f-]{36})$/.exec(location.pathname)?.[1];
const publicSlug=/^\/t\/([a-zA-Z0-9_-]+)$/.exec(location.pathname)?.[1];
let eventData=asEvent(emptyDocument()),data=eventData.divisions[0],activeDivision='main',activeStep='roster',record=null,dirty=false,busy=false,fontData=null,nextOffset=null;
let publicETag='',pollSeconds=300,pollTimer=null,lastRequest=null,publicFetching=false;
const acknowledged=new Set(),rosterDrafts=new Map();
const allComplete=()=>eventData.divisions.every(bracketComplete);
const matchLabels=ids=>ids.map(id=>{const [division,match]=id.split('/');return match?`${eventData.divisions.find(d=>d.id===division)?.name??division} ${match}`:id;}).join('、');

function notify(message,success=false){const box=$('#message');box.textContent=message;box.classList.toggle('success',success);box.hidden=!message;}
function element(tag,value,className){const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
function complete(){return bracketComplete(data);}
function markDirty(){dirty=true;lastRequest=null;updateActions();}
function updateActions(){
  if(!admin||!record)return;
  $('#saveState').textContent=dirty?'未保存の変更があります':`保存版 ${record.draftRevision} ／ ${record.publishedRevision?`公開版 ${record.publishedRevision}`:'未公開'}`;
  $('#saveButton').disabled=busy||!dirty;
  $('#publishButton').disabled=busy||dirty||!allComplete()||!eventData.title.trim()||eventData.divisions.some(d=>!d.name.trim());
  $('#unpublishButton').disabled=busy||!record.publishedRevision;
  $('#pdfButton').disabled=busy||!complete()||dirty||!fontData;
  $('#publicLink').href=`/t/${record.slug}`;$('#publicLink').hidden=!record.publishedRevision;
}

async function request(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',...options});
  let body;try{body=await response.json();}catch{throw new Error('通信に失敗しました。ログイン状態を確認してください');}
  if(!response.ok){const error=new Error(body.error??'通信に失敗しました');error.status=response.status;error.details=body;throw error;}
  return body;
}
const apiPath=()=>`/api/admin/tournaments/${record.id}`;

function applyEventChange(input){
  try{
    const change=prepareChange(eventData,input);
    if(change.affectedMatches.length&&!confirm(`次の試合の勝者・得点・注記などを取り消します。\n${matchLabels(change.affectedMatches)}\n変更を続けますか？`))return false;
    change.affectedMatches.forEach(id=>acknowledged.add(id));
    eventData=change.document;
    data=eventData.divisions.find(d=>d.id===activeDivision)??eventData.divisions[0];activeDivision=data.id;
    markDirty();render();return true;
  }catch(error){notify(error.message);return false;}
}
function applyChange(input){
  return applyEventChange({...eventData,divisions:eventData.divisions.map(d=>d.id===activeDivision?input:d)});
}
function setStep(step){
  activeStep=step;
  for(const button of document.querySelectorAll('[data-step]'))button.setAttribute('aria-pressed',String(button.dataset.step===step));
  for(const panel of document.querySelectorAll('[data-step-panel]'))panel.hidden=panel.dataset.stepPanel!==step;
}
function renderDivisions(){
  const tabs=$('#divisionTabs');tabs.replaceChildren();
  eventData.divisions.forEach(division=>{
    const button=element('button',`${division.name||'名称未設定'} ・ ${division.participants.length}組${admin&&!bracketComplete(division)?' / 準備中':''}`);
    button.type='button';button.setAttribute('aria-pressed',String(division.id===activeDivision));
    button.addEventListener('click',()=>{activeDivision=division.id;data=division;render();});tabs.append(button);
  });
  $('#addDivision').hidden=!admin;$('#addDivision').disabled=eventData.divisions.length>=MAX_DIVISIONS;
  $('#divisionName').value=data.name;$('#divisionType').value=data.type;
  $('#removeDivision').disabled=eventData.divisions.length===1;
  $('#previewTitle').textContent=data.name||'トーナメント表';
  $('#newParticipants').value=rosterDrafts.get(activeDivision)??'';
  $('#teamHelp').hidden=data.type!=='team';
}
function renderParticipants(){
  $('#entrantCount').textContent=`${data.participants.length} / ${MAX_ENTRANTS}組`;
  const container=$('#participantList');container.replaceChildren();
  data.participants.forEach((entry,index)=>{
    const row=element('div','','participant-row');
    const heading=element('div','','participant-status'),slot=data.slots.indexOf(entry.id);
    heading.append(element('strong',`${index+1}. ${entry.name}`),element('span',slot>=0?`配置済み：枠 ${slot+1}`:'未配置',slot>=0?'assigned':'unassigned'));
    row.append(heading);
    for(const [key,label] of [['organization','団体名'],['name',data.type==='team'?'チーム名':'氏名']]){
      const wrapper=element('label',label),input=document.createElement('input');input.value=entry[key]??'';input.maxLength=100;input.setAttribute('aria-label',`${index+1}番目の${label}`);
      input.addEventListener('change',()=>{const next=structuredClone(data);next.participants[index][key]=input.value.trim();if(!applyChange(next))input.value=entry[key]??'';});
      wrapper.append(input);row.append(wrapper);
    }
    const controls=element('div','','participant-controls'),label=element('label','シード'),seed=document.createElement('select');
    for(let rank=0;rank<=Math.min(4,data.participants.length);rank++){const option=element('option',rank?`第${rank}シード`:'指定なし');option.value=String(rank);seed.append(option);}
    seed.value=String(entry.seed??0);seed.setAttribute('aria-label',`${index+1}番目のシード`);
    seed.addEventListener('change',()=>{const next=structuredClone(data);next.participants[index].seed=Number(seed.value)||null;try{next.slots=orderedSlots(next.participants);if(!applyChange(next))seed.value=String(entry.seed??0);}catch(error){notify(error.message);seed.value=String(entry.seed??0);}});
    label.append(seed);
    const remove=element('button','削除');remove.type='button';remove.setAttribute('aria-label',`${entrantLabel(entry)}を削除`);
    remove.addEventListener('click',()=>applyChange(removeEntrant(data,entry.id)));
    controls.append(label,remove);row.append(controls);container.append(row);
  });
}

function renderSlots(){
  const assigned=data.slots.filter(Boolean).length,pending=data.participants.filter(p=>!data.slots.includes(p.id));
  $('#slotHelp').textContent=`${data.participants.length}組中 ${assigned}組を配置済み ／ 未配置 ${pending.length}組 ／ 不戦勝枠 ${Math.max(0,data.slots.length-data.participants.length)}枠`;
  $('#placementProgress').max=Math.max(1,data.participants.length);$('#placementProgress').value=assigned;
  $('#pendingList').textContent=pending.length?`未配置：${pending.map(entrantLabel).join('、')}`:'全員の配置が完了しています。手動で入れ替えることもできます。';
  if(data.participants.length<2)$('#pendingList').textContent='「1 名簿」で参加者を2組以上登録してください。';
  $('#pendingList').classList.toggle('unassigned',pending.length>0);
  $('#fillSlots').disabled=pending.length===0;$('#rebuildSlots').disabled=data.participants.length===0;
  const container=$('#slotList');container.replaceChildren();
  for(let index=0;index<data.slots.length;index+=2){
    const card=element('div','','slot-card');card.append(element('strong',`第1回戦・${index/2+1}組`));
    const pair=element('div','','slot-pair');
    for(let offset=0;offset<2;offset++){
      const slot=index+offset,label=element('label',`枠 ${slot+1}`),select=document.createElement('select');select.setAttribute('aria-label',`枠 ${slot+1}の参加者`);
      const blank=element('option','空き枠（不戦勝）');blank.value='';select.append(blank);
      for(const entry of data.participants){const placed=data.slots.indexOf(entry.id);const option=element('option',`${entrantLabel(entry)}${placed>=0?` ［枠 ${placed+1}］`:' ［未配置］'}`);option.value=entry.id;select.append(option);}
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
    card.append(element('p',`${entrantLabel(players[0])||'勝者待ち'} 対 ${entrantLabel(players[1])||'勝者待ち'}`,'match-players'));
    const label=element('label','勝者'),select=document.createElement('select');select.setAttribute('aria-label',`${match.id}の勝者`);
    const blank=element('option','勝者未確定');blank.value='';select.append(blank);
    for(const entry of players.filter(Boolean)){const option=element('option',entrantLabel(entry));option.value=entry.id;select.append(option);}
    select.value=data.results[match.id]??'';select.disabled=!ready;
    select.addEventListener('change',()=>{const next=structuredClone(data);if(select.value)next.results[match.id]=select.value;else delete next.results[match.id];if(!applyChange(next))select.value=data.results[match.id]??'';});
    label.append(select);card.append(label);
    const fields=element('div','','match-fields'),scores=element('div','','score-pair');
    detailField(scores,match.id,'scoreA','左の得点','number',!ready);detailField(scores,match.id,'scoreB','右の得点','number',!ready);fields.append(scores);
    detailField(fields,match.id,'scheduledAt','開始日時（日本時間）','datetime-local');detailField(fields,match.id,'venue','会場');detailField(fields,match.id,'notes','試合の注記','textarea');
    card.append(fields);container.append(card);
  }
}

function selectedDocument(){return {...data,title:`${eventData.title||'大会組合せ表'} ／ ${data.name}`,date:eventData.date,notes:eventData.notes};}
function getScenes(){return documentScenes(selectedDocument(),{measure:fontData?.measure,label:admin?(dirty?'未保存の下書き':`下書き / 保存版 ${record?.draftRevision??''}`):`公開版 ${record?.revision??''}`});}
function renderPreview(){
  const pages=$('#pages'),empty=$('#previewEmpty');pages.replaceChildren();
  if(!complete()){empty.hidden=false;empty.textContent=admin?(data.participants.length<2?'「1 名簿」の入力欄に参加者を貼り付けて「追加して組合せを作成」を押してください。2組以上で表を表示します。':'未配置の参加者がいます。「2 組合せ」で未配置者を確認してください。'):'公開中の大会が見つかりません。';$('#pageSummary').textContent='';$('#pdfButton').disabled=true;return;}
  try{
    const scenes=getScenes();empty.hidden=true;
    scenes.forEach((scene,index)=>{const page=element('section','','sheet');page.setAttribute('aria-label',`${index+1}ページ`);page.innerHTML=renderSVG(scene);pages.append(page);});
    $('#pageSummary').textContent=`${data.participants.length}組・${scenes.length}ページ・A4縦${fontData?'':' ／ フォント読込中'}`;
    $('#pdfButton').disabled=busy||admin&&dirty||!fontData;
  }catch(error){empty.hidden=false;empty.textContent=error.message;$('#pdfButton').disabled=true;}
}

function render(){
  $('#appView').hidden=false;$('#appView').classList.toggle('public-only',!admin);$('#mobileSections').hidden=!admin;$('#editor').hidden=!admin;
  for(const selector of ['#saveButton','#publishButton','#unpublishButton','#reloadButton','#logoutButton'])$(selector).hidden=!admin;
  $('#refreshButton').hidden=admin;$('#capacity').disabled=!admin;
  $('#heroTitle').textContent=eventData.title||'大会組合せ表';$('#heroMeta').textContent=[eventData.date,eventData.notes].filter(Boolean).join(' ｜ ');
  $('#heroEyebrow').textContent=admin?'ORGANIZER WORKSPACE':'TOURNAMENT BOARD';$('#capacity').value=data.layoutSettings.slotsPerPage;
  renderDivisions();
  if(admin){$('#title').value=eventData.title;$('#date').value=eventData.date;$('#notes').value=eventData.notes;renderParticipants();renderSlots();renderMatches();updateActions();setStep(activeStep);}
  renderPreview();
}

function loadRecord(value){record=value;eventData=asEvent(value.document);data=eventData.divisions.find(d=>d.id===activeDivision)??eventData.divisions[0];activeDivision=data.id;dirty=false;acknowledged.clear();lastRequest=null;$('.event-settings').open=!eventData.title.trim();render();}
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
    if(response.status===404){record=null;eventData=asEvent(emptyDocument());data=eventData.divisions[0];publicETag='';render();notify('現在、この大会は公開されていません。');return;}
    if(response.status!==304){if(!response.ok)throw new Error('公開データを取得できませんでした');record=await response.json();eventData=asEvent(record.document);data=eventData.divisions.find(d=>d.id===activeDivision)??eventData.divisions[0];activeDivision=data.id;publicETag=response.headers.get('etag')??'';render();}
    $('#saveState').textContent=`最終確認 ${new Date().toLocaleTimeString('ja-JP')} ／ ${Math.round(pollSeconds/60)}分ごとに確認`;
    if(manual)notify('最新の公開内容を確認しました',true);
  }catch(error){notify(`${error.message}。表示中の内容は最新ではない可能性があります。`);}
  finally{publicFetching=false;schedulePoll();}
}
function schedulePoll(){clearTimeout(pollTimer);if(!document.hidden&&publicSlug)pollTimer=setTimeout(()=>updatePublic(),pollSeconds*1000);}
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);if(!document.hidden)updatePublic();});

for(const [selector,key] of [['#title','title'],['#date','date'],['#notes','notes']])$(selector).addEventListener('input',event=>{eventData[key]=event.target.value;markDirty();$('#heroTitle').textContent=eventData.title||'大会組合せ表';$('#heroMeta').textContent=[eventData.date,eventData.notes].filter(Boolean).join(' ｜ ');renderPreview();});
$('#newParticipants').addEventListener('input',()=>rosterDrafts.set(activeDivision,$('#newParticipants').value));
$('#addParticipants').addEventListener('click',()=>{
  try{
    const entries=parseRoster($('#newParticipants').value,{type:data.type});
    if(data.participants.length+entries.length>MAX_ENTRANTS)return notify('参加者は部門ごとに最大64組です');
    const next=structuredClone(data);next.participants.push(...entries);
    next.slots=orderedSlots(next.participants);
    if(applyChange(next)){rosterDrafts.delete(activeDivision);$('#newParticipants').value='';setStep('placement');notify(`${entries.length}組を追加し、入力順で組合せを作成しました。`,true);}
  }catch(error){notify(error.message);}
});
$('#rebuildSlots').addEventListener('click',()=>{const next=structuredClone(data);next.slots=orderedSlots(next.participants);if(applyChange(next))notify('名簿の順番とシード指定から組合せを作り直しました。',true);});
$('#fillSlots').addEventListener('click',()=>{const next=structuredClone(data);for(const entry of next.participants.filter(p=>!next.slots.includes(p.id)))next.slots[next.slots.indexOf(null)]=entry.id;applyChange(next);});
for(const button of document.querySelectorAll('[data-step]'))button.addEventListener('click',()=>setStep(button.dataset.step));
$('#addDivision').addEventListener('click',()=>{
  if(eventData.divisions.length>=MAX_DIVISIONS)return;
  const division=emptyDivision(`d_${crypto.randomUUID().replaceAll('-','')}`,`部門${eventData.divisions.length+1}`);
  if(applyEventChange({...eventData,divisions:[...eventData.divisions,division]})){activeDivision=division.id;data=eventData.divisions.at(-1);activeStep='roster';render();$('#divisionName').focus();$('#divisionName').select();}
});
$('#removeDivision').addEventListener('click',()=>{
  if(eventData.divisions.length<=1||!confirm(`「${data.name}」の名簿・組合せ・試合情報を削除しますか？`))return;
  const removedId=activeDivision;
  if(applyEventChange({...eventData,divisions:eventData.divisions.filter(d=>d.id!==activeDivision)}))rosterDrafts.delete(removedId);
});
$('#divisionName').addEventListener('input',event=>{data.name=event.target.value;markDirty();$('#previewTitle').textContent=data.name;renderPreview();});
$('#divisionName').addEventListener('change',()=>renderDivisions());
$('#divisionType').addEventListener('change',()=>{const next=structuredClone(data);next.type=$('#divisionType').value;applyChange(next);});
$('#capacity').addEventListener('change',()=>{data.layoutSettings.slotsPerPage=Number($('#capacity').value);markDirty();renderPreview();});
$('#saveButton').addEventListener('click',async()=>{
  if(busy)return;
  try{
    const normalized=documentContent(eventData);
    const body=lastRequest??={document:normalized,expectedLockVersion:record.lockVersion,mutationId:crypto.randomUUID(),acknowledgedMatches:[...acknowledged]};
    busy=true;updateActions();notify('');
    const saved=await request(`${apiPath()}/draft`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    loadRecord(saved);notify('下書きを保存しました。公開内容は変わりません。',true);
  }catch(error){notify(error.message);if(error.details?.code==='CONFIRMATION_REQUIRED'&&confirm(`${error.message}\n${matchLabels(error.details.affectedMatches)}\n取り消して保存しますか？`)){error.details.affectedMatches.forEach(id=>acknowledged.add(id));lastRequest=null;setTimeout(()=>$('#saveButton').click());}}
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
$('#pdfButton').addEventListener('click',async()=>{
  if(busy||dirty||!complete())return;
  const snapshot=structuredClone(selectedDocument()),revision=admin?record.draftRevision:record.revision;
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
