import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedSlots,parseRoster,removeEntrant} from '../src/placement.js';
import {createTournament,documentScenes} from '../src/engine.js';
import {emptyDivision} from '../src/model.js';

test('名簿の名前・団体名を入力順に読み取り、団体戦のチーム名の空白を保持する',()=>{
  let serial=0;
  const entries=parseRoster('城南中学校 田中圭太\n城北中学校\t佐藤 健太\n道場,鈴木悠斗\n山田太郎',{id:()=>`p${++serial}`});
  assert.deepEqual(entries.map(p=>[p.organization,p.name]),[['城南中学校','田中圭太'],['城北中学校','佐藤 健太'],['道場','鈴木悠斗'],['','山田太郎']]);
  assert.equal(parseRoster('城南中学校 Aチーム',{type:'team'})[0].name,'城南中学校 Aチーム');
  assert.throws(()=>parseRoster('道場,'));
  assert.throws(()=>parseRoster('あ'.repeat(101)));
});

test('2〜64組すべてで入力順を保ち、不戦勝を第1回戦に分散させる',()=>{
  for(let n=2;n<=64;n++){
    const entries=Array.from({length:n},(_,i)=>({id:`p${i+1}`,name:`参加者${i+1}`,seed:null}));
    const slots=orderedSlots(entries);
    assert.deepEqual(slots.filter(Boolean),entries.map(p=>p.id));
    assert.equal(createTournament(entries,{},slots).matches.length,n-1);
    for(let i=0;i<slots.length;i+=2)assert(slots[i]||slots[i+1]);
    assert.deepEqual(orderedSlots(entries),slots);
  }
});

test('全参加組数でシード4組を分離し、順位の高いシードから不戦勝を割り当てる',()=>{
  for(let n=4;n<=64;n++){
    const entries=Array.from({length:n},(_,i)=>({id:`p${i+1}`,name:`参加者${i+1}`,seed:i<4?i+1:null}));
    const slots=orderedSlots(entries),size=slots.length;
    assert.deepEqual(entries.slice(0,4).map(p=>slots.indexOf(p.id)),[0,size-1,size/2,size/2-1]);
    assert.deepEqual(slots.filter(id=>id&&!entries.slice(0,4).some(p=>p.id===id)),entries.slice(4).map(p=>p.id));
    assert.equal(createTournament(entries,{},slots).matches.length,n-1);
    for(let i=0;i<Math.min(4,size-n);i++)assert.equal(slots[slots.indexOf(`p${i+1}`)^1],null);
  }
  assert.throws(()=>orderedSlots([{id:'a',seed:1},{id:'b',seed:1}]));
});

test('手動配置からの削除で枠数が縮んでも、残りの配置を失わない',()=>{
  const bracket={...emptyDivision(),participants:Array.from({length:5},(_,i)=>({id:`p${i+1}`,name:`参加者${i+1}`,seed:null})),slots:['p1',null,'p2',null,'p3',null,'p4','p5']};
  const removed=removeEntrant(bracket,'p1');
  assert.equal(removed.slots.length,4);
  assert.deepEqual(new Set(removed.slots),new Set(['p2','p3','p4','p5']));
  assert.equal(createTournament(removed.participants,{},removed.slots).matches.length,3);
});

test('団体名と氏名、部門名を画面・PDF共通の描画データへ含める',()=>{
  const division={...emptyDivision(),name:'中学生・個人戦',participants:[{id:'p1',name:'田中圭太',organization:'城南中学校'},{id:'p2',name:'佐藤健太',organization:'城北中学校'}],slots:['p1','p2']};
  const scenes=documentScenes({...division,title:`秋季大会 ／ ${division.name}`});
  const labels=scenes.flatMap(s=>s.shapes.filter(s=>s.type==='text').map(s=>s.value));
  assert(labels.some(s=>s.includes('秋季大会 ／ 中学生・個人戦')));
  assert(labels.includes('田中圭太'));
  assert(labels.some(s=>s.includes('城南中学校')));
});
