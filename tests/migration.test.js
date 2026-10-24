import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
process.env.NODE_ENV='test';
const {createDb}=await import('../server.js');
test('failed migration rolls back schema changes and preserves existing records',()=>{
 const directory=mkdtempSync(join(tmpdir(),'schema-rollback-')),file=join(directory,'db.sqlite');let db;
 try{
  db=new DatabaseSync(file);db.exec("CREATE TABLE monitors(id INTEGER PRIMARY KEY,name TEXT,url TEXT,status TEXT,response_ms INTEGER,uptime REAL,last_checked TEXT);INSERT INTO monitors VALUES(1,'Keep','https://memorim.github.io/','operational',1,99,'2026-10-20');CREATE TABLE incidents(id INTEGER PRIMARY KEY,title TEXT,detail TEXT,severity TEXT,status TEXT,started_at TEXT,resolved_at TEXT,monitor_id INTEGER);INSERT INTO incidents VALUES(1,'a','b','major','investigating','2026-10-20',NULL,1),(2,'a','b','major','investigating','2026-10-20',NULL,1);");db.close();db=null;
  assert.throws(()=>createDb(file));db=new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA table_info(monitors)').all().some(c=>c.name==='enabled'),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM monitors').get().n,1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{db?.close();assert.ok(realpathSync(directory).startsWith(realpathSync(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});}
});
