import {createTournament,renderTournament} from './engine.js';
import {emptyDocument,slotCapacity,validateDocument,reconcileResults,downstreamResults,MAX_ENTRANTS} from './model.js';

const $=selector=>document.querySelector(selector);
const admin=location.pathname==='/admin';
let data=emptyDocument();
let dirty=false;
let busy=false;

function notify(message,success=false) {
  const box=$('#message');
  box.textContent=message;
  box.classList.toggle('success',success);
  box.hidden=!message;
}

function markDirty() {
  dirty=true;
  $('#saveState').textContent='未保存の変更があります';
  $('#saveButton').disabled=false;
}

function complete() {
  return data.participants.length>=2 && data.slots.filter(Boolean).length===data.participants.length;
}

function textElement(tag,value,className) {
  const node=document.createElement(tag);
  node.textContent=value;
  if (className) node.className=className;
  return node;
}

function applyStructure(next) {
  const {results,removed}=reconcileResults(data,next);
  if (removed.length && !window.confirm(`組合せの変更により、次の確定結果を取り消します。\n${removed.join('、')}\n\n変更を続けますか？`)) return false;
  next.results=results;
  data=next;
  markDirty();
  render();
  return true;
}

function renderParticipants() {
  $('#entrantCount').textContent=`${data.participants.length} / ${MAX_ENTRANTS}`;
  const container=$('#participantList');
  container.replaceChildren();
  data.participants.forEach((entrant,index)=>{
    const row=textElement('div','', 'participant-row');
    row.append(textElement('span',String(index+1)));
    const input=document.createElement('input');
    input.value=entrant.name; input.maxLength=100; input.setAttribute('aria-label',`${index+1}番目の参加者名`);
    input.addEventListener('change',()=>{
      const name=input.value.trim();
      if (!name) {input.value=entrant.name;notify('参加者名を入力してください');return;}
      entrant.name=name;markDirty();renderPreview();renderMatches();
    });
    row.append(input);
    const remove=textElement('button','削除');
    remove.type='button';remove.setAttribute('aria-label',`${entrant.name}を削除`);
    remove.addEventListener('click',()=>{
      const next=structuredClone(data);
      next.participants.splice(index,1);
      next.slots=next.slots.map(id=>id===entrant.id?null:id).slice(0,slotCapacity(next.participants.length));
      applyStructure(next);
    });
    row.append(remove);container.append(row);
  });
}

function renderSlots() {
  const assigned=data.slots.filter(Boolean).length;
  $('#slotHelp').textContent=`${data.slots.length}枠中 ${assigned}枠を指定済み。空欄はBYEとして扱い、試合は表示しません。`;
  const container=$('#slotList');container.replaceChildren();
  for (let index=0;index<data.slots.length;index+=2) {
    const card=textElement('div','', 'slot-card');
    card.append(textElement('strong',`第１回戦・${index/2+1}組`));
    const pair=textElement('div','', 'slot-pair');
    for (let offset=0;offset<2;offset++) {
      const slot=index+offset;
      const label=textElement('label',`枠 ${slot+1}`);
      const select=document.createElement('select');
      select.setAttribute('aria-label',`枠 ${slot+1}の参加者`);
      const blank=document.createElement('option');blank.value='';blank.textContent='空欄（BYE）';select.append(blank);
      data.participants.forEach(entrant=>{
        const option=document.createElement('option');option.value=entrant.id;option.textContent=entrant.name;select.append(option);
      });
      select.value=data.slots[slot]??'';
      select.addEventListener('change',()=>{
        const next=structuredClone(data);
        const chosen=select.value||null;
        const former=next.slots[slot];
        const other=chosen?next.slots.indexOf(chosen):-1;
        if (other>=0 && other!==slot) next.slots[other]=former;
        next.slots[slot]=chosen;
        if (!applyStructure(next)) select.value=former??'';
      });
      label.append(select);pair.append(label);
    }
    card.append(pair);container.append(card);
  }
}

function renderMatches() {
  const container=$('#matchList');container.replaceChildren();
  if (!complete()) {container.append(textElement('p','全参加者の枠を指定すると、試合が表示されます。','help'));return;}
  let tournament;
  try {tournament=createTournament(data.participants,data.results,data.slots);} catch(error) {notify(error.message);return;}
  for (const match of tournament.matches.filter(m=>!m.bye)) {
    const card=textElement('div','', 'match-card');
    card.append(textElement('strong',`第${match.depth}回戦・${match.id}`));
    const [a,b]=match.children.map(c=>c.winner);
    card.append(textElement('p',`${a?.name??'勝者待ち'}　対　${b?.name??'勝者待ち'}`,'match-players'));
    const select=document.createElement('select');
    select.setAttribute('aria-label',`${match.id}の勝者`);
    const blank=document.createElement('option');blank.value='';blank.textContent='勝者未確定';select.append(blank);
    for (const entrant of [a,b].filter(Boolean)) {
      const option=document.createElement('option');option.value=entrant.id;option.textContent=entrant.name;select.append(option);
    }
    select.value=data.results[match.id]??'';
    select.disabled=!(a&&b&&match.children.every(c=>c.resolved));
    select.addEventListener('change',()=>{
      const removed=downstreamResults(data.results,match.id,data.slots.length);
      if (removed.length && !window.confirm(`勝者の変更により、後続試合 ${removed.join('、')} の結果を取り消します。続けますか？`)) {
        select.value=data.results[match.id]??'';return;
      }
      removed.forEach(id=>delete data.results[id]);
      if (select.value) data.results[match.id]=select.value;
      else delete data.results[match.id];
      markDirty();renderMatches();renderPreview();
    });
    card.append(select);container.append(card);
  }
}

function renderPreview() {
  const empty=$('#previewEmpty'),pages=$('#pages');
  pages.replaceChildren();
  if (!complete()) {
    empty.hidden=false;
    empty.textContent=admin?'参加者を２名以上登録し、全員を枠に割り当てるとプレビューが表示されます。':'公開中のトーナメント表はありません。';
    $('#pageSummary').textContent='';$('#printButton').disabled=true;return;
  }
  try {
    const output=renderTournament(data.participants,{slotIds:data.slots,results:data.results,title:data.title||'トーナメント表',slotsPerPage:Number($('#capacity').value)});
    empty.hidden=true;
    output.svgs.forEach((svg,index)=>{
      const page=textElement('section','', 'sheet');
      page.setAttribute('aria-label',`${index+1}ページ`);
      page.innerHTML=svg;
      pages.append(page);
    });
    $('#pageSummary').textContent=`${data.participants.length}名・${output.pages.length}ページ・A4縦`;
    $('#printButton').disabled=false;
  } catch(error) {
    empty.hidden=false;empty.textContent=error.message;
    $('#printButton').disabled=true;
  }
}

function render() {
  $('#appView').hidden=false;
  $('#appView').classList.toggle('public-only',!admin);
  $('#editor').hidden=!admin;
  $('#saveButton').hidden=!admin;
  $('#logoutButton').hidden=!admin;
  $('#heroEyebrow').textContent=admin?'ORGANIZER WORKSPACE':'PUBLIC TOURNAMENT BOARD';
  $('#heroTitle').textContent=data.title||'大会組合せ表';
  $('#heroMeta').textContent=[data.date,data.notes].filter(Boolean).join('　｜　');
  if (admin) {
    $('#title').value=data.title;$('#date').value=data.date;$('#notes').value=data.notes;$('#published').checked=data.published;
    renderParticipants();renderSlots();renderMatches();
    $('#saveState').textContent=dirty?'未保存の変更があります':data.updatedAt?`保存済み ${new Date(data.updatedAt).toLocaleString('ja-JP')}`:'未保存';
    $('#saveButton').disabled=busy||!dirty;
  }
  renderPreview();
}

async function request(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',...options});
  const body=await response.json();
  if (!response.ok) throw new Error(body.error??'通信に失敗しました');
  return body;
}

async function loadAdmin() {
  const session=await request('/api/admin/session');
  if (!session.authenticated) {$('#loginView').hidden=false;$('#appView').hidden=true;return;}
  $('#loginView').hidden=true;
  data=await request('/api/admin/tournament');dirty=false;render();
}

async function start() {
  try {
    if (admin) await loadAdmin();
    else {data=await request('/api/public')??emptyDocument();render();}
  } catch(error) {notify(error.message);}
}

$('#loginForm').addEventListener('submit',async event=>{
  event.preventDefault();notify('');
  try {
    await request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#password').value})});
    $('#password').value='';await loadAdmin();
  } catch(error) {notify(error.message);}
});

for (const [selector,key] of [['#title','title'],['#date','date'],['#notes','notes']]) {
  $(selector).addEventListener('input',event=>{
    data[key]=event.target.value;
    markDirty();
    if (key==='title' || key==='date' || key==='notes') {$('#heroTitle').textContent=data.title||'大会組合せ表';$('#heroMeta').textContent=[data.date,data.notes].filter(Boolean).join('　｜　');}
    if (key==='title') renderPreview();
  });
}
$('#published').addEventListener('change',event=>{data.published=event.target.checked;markDirty();});
$('#addParticipants').addEventListener('click',()=>{
  const names=$('#newParticipants').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (!names.length) {notify('追加する参加者を入力してください');return;}
  if (data.participants.length+names.length>MAX_ENTRANTS) {notify('参加者は最大64名です');return;}
  if (names.some(name=>name.length>100)) {notify('参加者名は100文字以内にしてください');return;}
  const next=structuredClone(data);
  names.forEach(name=>next.participants.push({id:`p_${crypto.randomUUID().replaceAll('-','')}`,name}));
  while (next.slots.length<slotCapacity(next.participants.length)) next.slots.push(null);
  if (applyStructure(next)) {$('#newParticipants').value='';notify('');}
});
$('#capacity').addEventListener('change',renderPreview);
$('#printButton').addEventListener('click',()=>window.print());
$('#saveButton').addEventListener('click',async()=>{
  if (busy)return;
  try {
    const normalized=validateDocument(data);
    busy=true;$('#saveButton').disabled=true;$('#saveState').textContent='保存中…';notify('');
    data=await request('/api/admin/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...normalized,version:data.version})});
    dirty=false;render();notify('保存しました',true);
  } catch(error) {notify(error.message);$('#saveState').textContent='保存できませんでした';}
  finally {busy=false;$('#saveButton').disabled=!dirty;}
});
$('#logoutButton').addEventListener('click',async()=>{
  if (dirty&&!window.confirm('未保存の変更があります。ログアウトしますか？'))return;
  try {await request('/api/admin/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});dirty=false;await loadAdmin();}
  catch(error){notify(error.message);}
});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
start();
