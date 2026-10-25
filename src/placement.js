import {MAX_ENTRANTS,slotCapacity} from './model.js';

export const entrantLabel = entry => entry ? [entry.organization,entry.name].filter(Boolean).join(' ') : '';

/** A line is a name, or organization + name separated by a comma, tab or spaces. */
export function parseRoster(text,{type='individual',id=()=>`p_${crypto.randomUUID().replaceAll('-','')}`}={}) {
  const lines=String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('参加者名を入力してください');
  if (lines.length>MAX_ENTRANTS) throw new Error('参加者は部門ごとに最大64組です');
  return lines.map((line,index)=>{
    let parts=line.split(/[\t,，]/).map(part=>part.trim());
    if (parts.length===1&&type==='individual') parts=line.split(/[\s　]+/u).map(part=>part.trim());
    const organization=parts.length>1?parts.shift():'';
    const name=parts.join(' ');
    if (!name||name.length>100||organization.length>100) throw new Error(`参加者の${index+1}行目を確認してください。団体名・氏名は各100文字以内です`);
    return {id:id(),organization,name,seed:null};
  });
}

/** Deterministic placement: seeds first, then the remaining entrants in roster order. */
export function orderedSlots(participants) {
  const size=slotCapacity(participants.length),slots=Array(size).fill(null);
  if (!participants.length) return slots;
  const seeded=participants.filter(p=>p.seed!=null).sort((a,b)=>a.seed-b.seed);
  if (new Set(seeded.map(p=>p.seed)).size!==seeded.length) throw new Error('同じシード順位を複数の参加者に指定できません');
  const positions=[0,size-1,size/2,size/2-1];
  for (const entry of seeded) {
    if (!Number.isInteger(entry.seed)||entry.seed<1||entry.seed>Math.min(4,participants.length)) throw new Error('参加者のシード順位を確認してください');
    slots[positions[entry.seed-1]]=entry.id;
  }
  const empty=new Set();
  const byeCount=size-participants.length;
  // Seeded players get available walkovers in rank order.
  for (const entry of seeded) {
    const opponent=positions[entry.seed-1]^1;
    if (empty.size<byeCount&&!slots[opponent]) empty.add(opponent);
  }
  const pairs=Array.from({length:size/2},(_,i)=>i),selected=[];
  for (const index of empty) selected.push(Math.floor(index/2));
  while (empty.size<byeCount) {
    const available=pairs.filter(pair=>!selected.includes(pair)&&!(slots[pair*2]&&slots[pair*2+1]));
    available.sort((a,b)=>{
      const distance=pair=>selected.length?Math.min(...selected.map(other=>Math.abs(other-pair))):size-pair;
      return distance(b)-distance(a)||a-b;
    });
    const pair=available[0];
    selected.push(pair);
    empty.add(slots[pair*2+1]?pair*2:pair*2+1);
  }
  const rest=participants.filter(p=>p.seed==null);
  let next=0;
  for (let index=0;index<size;index++) if (!empty.has(index)&&!slots[index]) slots[index]=rest[next++]?.id??null;
  return slots;
}

/** Shrinking a manually edited bracket must never lose another entrant's assignment. */
export function removeEntrant(bracket,id) {
  const next=structuredClone(bracket);
  next.participants=next.participants.filter(p=>p.id!==id).map(p=>({...p,seed:p.seed>Math.min(4,bracket.participants.length-1)?null:p.seed}));
  const capacity=slotCapacity(next.participants.length);
  const retained=next.slots.map(value=>value===id?null:value);
  next.slots=retained.slice(0,capacity);
  for (const value of retained.slice(capacity).filter(Boolean)) next.slots[next.slots.indexOf(null)]=value;
  return next;
}
