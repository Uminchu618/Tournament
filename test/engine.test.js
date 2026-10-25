import test from 'node:test';
import assert from 'node:assert/strict';
import {createTournament,renderTournament} from '../src/engine.js';

const entries=n=>Array.from({length:n},(_,i)=>({id:`p${i+1}`,name:`参加者 ${i+1}`}));
const slots=n=>Array.from({length:2**Math.ceil(Math.log2(n))},(_,i)=>i<n?`p${i+1}`:null);

for (const n of [2,3,5,7,8,9,16,17,31,32,33,64]) for (const capacity of [8,16,32]) {
  test(`${n}人・${capacity}枠: BYEなしの実試合とページ分割`,()=>{
    const {tournament,pages,scenes}=renderTournament(entries(n),{slotIds:slots(n),slotsPerPage:capacity});
    const real=tournament.matches;
    assert.equal(real.length,n-1);
    assert(real.every(m=>!m.bye));
    const drawn=new Set(scenes.flatMap(s=>s.shapes.filter(x=>x.matchId).map(x=>x.matchId)));
    assert.equal(drawn.size,n-1);
    assert(real.every(m=>drawn.has(m.id)));
    assert(!scenes.some(s=>s.shapes.some(x=>x.type==='text' && x.value==='BYE')));
    const ids=pages.flatMap(page=>page.matches.map(m=>m.id));
    assert.equal(ids.length,new Set(ids).size);
    for (const page of pages) {
      assert(page.inputs.length<=capacity);
      if(page.destination)assert(pages[page.destination-1].inputs.some(input=>input.id===page.root.id));
    }
    for (const scene of scenes) for (const shape of scene.shapes) {
      for (const key of ['x','x1','x2']) if(key in shape)assert(shape[key]>=10&&shape[key]<=200);
      for (const key of ['y','y1','y2']) if(key in shape)assert(shape[key]>=10&&shape[key]<=287);
    }
  });
}

test('運営者が指定した枠がそのまま対戦になる',()=>{
  const t=createTournament(entries(4),{},['p4','p2','p1','p3']);
  assert.deepEqual(t.rounds[1][0].children.map(x=>x.entrant.id),['p4','p2']);
  assert.deepEqual(t.rounds[1][1].children.map(x=>x.entrant.id),['p1','p3']);
});

test('空き枠は直接進出し、勝者を指定できる',()=>{
  const t=createTournament(entries(3),{'R1-M2':'p2','R2-M1':'p1'},['p1',null,'p2','p3']);
  assert(t.rounds[1][0].bye);
  assert.equal(t.root.winner.id,'p1');
  const {scenes}=renderTournament(entries(3),{slotIds:['p1',null,'p2','p3']});
  assert(!scenes[0].shapes.some(s=>s.matchId==='R1-M1'));
  assert.equal(new Set(scenes[0].shapes.filter(s=>s.matchId).map(s=>s.matchId)).size,2);
});

test('手動で離れた枠に配置してもBYE対戦は生じない',()=>{
  const placement=['p1',null,'p2',null,'p3',null,'p4','p5'];
  const {tournament,pages,scenes}=renderTournament(entries(5),{slotIds:placement,slotsPerPage:8});
  assert.equal(tournament.matches.length,4);
  assert.equal(pages.length,1);
  assert.equal(new Set(scenes[0].shapes.filter(s=>s.matchId).map(s=>s.matchId)).size,4);
});

test('未指定・重複枠・早すぎる結果を拒否する',()=>{
  assert.throws(()=>createTournament(entries(4),{},['p1','p2',null,null]));
  assert.throws(()=>createTournament(entries(4),{},['p1','p1','p3','p4']));
  assert.throws(()=>createTournament(entries(4),{'R2-M1':'p1'},slots(4)));
  assert.throws(()=>createTournament(entries(65),{},[]));
});

test('SVGは入力文字列をエスケープする',()=>{
  const participants=[{id:'p1',name:'<script>alert(1)</script>'},{id:'p2',name:'&"'}];
  const {svgs}=renderTournament(participants,{slotIds:['p1','p2'],title:'<img onerror="alert(1)">'});
  assert(!svgs[0].includes('<script>'));assert(!svgs[0].includes('<img '));
  assert(svgs[0].includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});
