import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument,validateDocument,reconcileResults,downstreamResults} from '../src/model.js';

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
