import {createTournament} from './engine.js';

export const MAX_ENTRANTS = 64;
export const slotCapacity = count => Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(1, count))));

export function emptyDocument() {
  return {title:'',date:'',notes:'',participants:[],slots:[null,null],results:{},published:false,version:0,updatedAt:null};
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateDocument(input) {
  if (!isObject(input)) throw new Error('大会データの形式が正しくありません');
  const title=String(input.title ?? '').trim();
  const date=String(input.date ?? '').trim();
  const notes=String(input.notes ?? '').trim();
  if (title.length > 100 || date.length > 100 || notes.length > 1000) throw new Error('大会情報の文字数が上限を超えています');
  if (!Array.isArray(input.participants) || input.participants.length > MAX_ENTRANTS) throw new Error('参加者は最大64名です');
  const participants=input.participants.map((entry,index)=>{
    if (!isObject(entry) || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 100) {
      throw new Error(`${index+1}番目の参加者を確認してください`);
    }
    return {id:entry.id,name:entry.name.trim()};
  });
  const ids=new Set(participants.map(x=>x.id));
  if (ids.size !== participants.length) throw new Error('参加者IDが重複しています');
  const capacity=slotCapacity(participants.length);
  if (!Array.isArray(input.slots) || input.slots.length !== capacity) throw new Error(`組合せは${capacity}枠で指定してください`);
  const slots=input.slots.map(id=>{
    if (id !== null && (typeof id !== 'string' || !ids.has(id))) throw new Error('存在しない参加者が枠に指定されています');
    return id;
  });
  const assigned=slots.filter(Boolean);
  if (new Set(assigned).size !== assigned.length) throw new Error('同じ参加者を複数の枠に割り当てられません');
  if (!isObject(input.results)) throw new Error('試合結果の形式が正しくありません');
  const results={};
  for (const [id,winner] of Object.entries(input.results)) {
    if (!/^R[1-6]-M[1-9][0-9]*$/.test(id) || typeof winner !== 'string' || !ids.has(winner)) throw new Error('試合結果の形式が正しくありません');
    results[id]=winner;
  }
  const complete=participants.length>=2 && assigned.length===participants.length;
  if (!complete && Object.keys(results).length) throw new Error('組合せが未完成のため、結果を保存できません');
  if (complete) createTournament(participants,results,slots);
  const published=input.published===true;
  if (published && (!title || !complete)) throw new Error('公開には大会名と完成した組合せが必要です');
  return {title,date,notes,participants,slots,results,published};
}

function slotSignature(slots, matchId) {
  const match=/^R([1-6])-M([1-9][0-9]*)$/.exec(matchId);
  if (!match) return null;
  const size=2**Number(match[1]);
  const start=(Number(match[2])-1)*size;
  return JSON.stringify(slots.slice(start,start+size));
}

/** Preserve only results whose entire bracket subtree and winner still remain valid. */
export function reconcileResults(before, after) {
  const existing=before.results ?? {};
  const removed=[];
  const kept={};
  const complete=after.participants.length>=2 && after.slots.filter(Boolean).length===after.participants.length;
  if (!complete) return {results:{},removed:Object.keys(existing)};
  const keys=Object.keys(existing).sort((a,b)=>Number(a.match(/^R(\d+)/)[1])-Number(b.match(/^R(\d+)/)[1]));
  for (const key of keys) {
    if (slotSignature(before.slots,key)!==slotSignature(after.slots,key)) {removed.push(key);continue;}
    try { createTournament(after.participants,{...kept,[key]:existing[key]},after.slots);kept[key]=existing[key]; }
    catch { removed.push(key); }
  }
  return {results:kept,removed};
}

/** A corrected winner invalidates only played matches on its path to the final. */
export function downstreamResults(results, matchId, capacity) {
  const match=/^R([1-6])-M([1-9][0-9]*)$/.exec(matchId);
  if (!match) return [];
  let round=Number(match[1]), index=Number(match[2]);
  const removed=[];
  while (round<Math.log2(capacity)) {
    round++; index=Math.ceil(index/2);
    const id=`R${round}-M${index}`;
    if (results[id]!==undefined) removed.push(id);
  }
  return removed;
}
