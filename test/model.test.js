import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument,validateDocument,asEvent,prepareChange,validateForPublication,reconcileResults,downstreamResults} from '../src/model.js';

const people=Array.from({length:4},(_,i)=>({id:`p${i+1}`,name:`参加者${i+1}`}));
const doc=(slots=['p1','p2','p3','p4'],results={})=>({...emptyDocument(),title:'大会',participants:people,slots,results});

test('未配置の下書きは保存できるが公開はできない',()=>{
  assert.deepEqual(validateDocument(doc([null,null,null,null])).slots,[null,null,null,null]);
  assert.throws(()=>validateDocument({...doc([null,null,null,null]),published:true}));
});

test('組合せ変更では影響のある結果だけを消す',()=>{
  const before=doc(undefined,{'R1-M1':'p1','R1-M2':'p3','R2-M1':'p1'});
  const after=doc(['p2','p1','p3','p4']);
  const change=reconcileResults(before,after);
  assert.deepEqual(change.results,{'R1-M2':'p3'});
  assert.deepEqual(change.removed,['R1-M1','R2-M1']);
});

test('勝者訂正は後続の確定結果を列挙する',()=>{
  assert.deepEqual(downstreamResults({'R2-M1':'p1','R3-M1':'p1'},'R1-M1',8),['R2-M1','R3-M1']);
});

test('同じ参加者の二重配置を拒否する',()=>{
  assert.throws(()=>validateDocument(doc(['p1','p1','p3','p4'])));
});

test('旧形式を部門へ移し、部門ごとの同じ試合IDを独立して保存・訂正する',()=>{
  const before=asEvent(doc(undefined,{'R1-M1':'p1','R1-M2':'p3','R2-M1':'p1'}));
  before.divisions.push({...structuredClone(before.divisions[0]),id:'junior',name:'中学生'});
  const after=structuredClone(before);
  after.divisions[0].results['R1-M1']='p2';
  const change=prepareChange(before,after);
  assert.deepEqual(change.affectedMatches,['main/R2-M1']);
  assert.equal(change.document.divisions[0].results['R2-M1'],undefined);
  assert.equal(change.document.divisions[1].results['R2-M1'],'p1');
  assert.equal(validateForPublication(change.document).divisions.length,2);
});

test('部門削除は試合情報の取消対象を列挙し、重複IDと未完成の公開を拒否する',()=>{
  const before=asEvent(doc(undefined,{'R1-M1':'p1'}));
  before.divisions.push({...structuredClone(before.divisions[0]),id:'team',name:'団体戦',type:'team'});
  assert.deepEqual(prepareChange(before,{...before,divisions:[before.divisions[0]]}).affectedMatches,['team/R1-M1']);
  assert.throws(()=>validateDocument({...before,divisions:[before.divisions[0],before.divisions[0]]}));
  assert.throws(()=>prepareChange(before,{...before,divisions:[null]}),/大会の部門/);
  assert.throws(()=>prepareChange(before,{...before,divisions:null}),/大会の部門/);
  const incomplete=structuredClone(before);incomplete.divisions[1].slots=[null,null,null,null];incomplete.divisions[1].results={};
  assert.throws(()=>validateForPublication(incomplete));
  assert.throws(()=>validateForPublication({...before,divisions:[{...before.divisions[0],name:''}]}));
});
