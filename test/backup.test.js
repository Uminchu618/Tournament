import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {splitStatements,orderDump} from '../scripts/sql-dump.mjs';

test('SQL文字列のセミコロン・引用符・コメントを壊さず復元順を整理する',()=>{
  const source="-- header;\nCREATE TABLE a(id TEXT);\nINSERT INTO a VALUES('団体; ''名前'' -- /*本文*/'); /* comment; */ CREATE INDEX a_id ON a(id);";
  assert.equal(splitStatements(source).length,3);
  const sql=orderDump(source),db=new DatabaseSync(':memory:');db.exec(sql);assert.equal(db.prepare('SELECT id FROM a').get().id,"団体; '名前' -- /*本文*/");db.close();
});
test('循環参照を持つエクスポートでも先に全テーブルを作成して復元する',()=>{
  const source="CREATE TABLE a(id TEXT PRIMARY KEY,b_id TEXT REFERENCES b(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO a VALUES('a','b');CREATE TABLE b(id TEXT PRIMARY KEY,a_id TEXT REFERENCES a(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO b VALUES('b','a');";
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; BEGIN');db.exec(orderDump(source));db.exec('COMMIT');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
});
test('未対応のトリガーと途中で切れたSQLを復元前に拒否する',()=>{
  assert.throws(()=>orderDump('CREATE TRIGGER x AFTER INSERT ON a BEGIN SELECT 1; END;'));
  assert.throws(()=>orderDump("INSERT INTO a VALUES('unfinished"));
});
