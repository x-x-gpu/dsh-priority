import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Store} from './lib/store.js';
import {createApi} from './lib/api.js';

test('session mount API persists, deduplicates and detaches without changing task data', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'priority-test-'));
  const file=path.join(dir,'tasks.json');
  const store=new Store(file);
  const item=await store.add({title:'计划',due:'2026-11-03'});
  const handler=createApi(store);
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const call=(route,method,body)=>fetch(base+route,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    const route='/items/'+item.id+'/sessions';
    for(let i=0;i<2;i++) {
      const response=await call(route,'POST',{sessionId:'session-example',title:'我的对话'});
      assert.equal(response.status,200);
      assert.equal((await response.json()).sessions.length,1);
    }
    const reload=new Store(file);
    await reload.read();
    let saved=reload.view().buckets.flatMap(b=>b.items).find(i=>i.id===item.id);
    assert.equal(saved.sessions[0].title,'我的对话');
    assert.equal(saved.due,'2026-11-03');
    assert.equal((await call(route,'POST',{sessionId:''})).status,400);
    assert.equal((await call('/items/missing/sessions','POST',{sessionId:'x'})).status,404);
    assert.equal((await call(route,'DELETE')).status,400);
    assert.equal((await call(route+'?sessionId=session-example','DELETE')).status,200);
    await reload.read();
    saved=reload.view().buckets.flatMap(b=>b.items).find(i=>i.id===item.id);
    assert.deepEqual(saved.sessions,[]);
    assert.equal(saved.title,'计划');
    assert.equal(saved.status,'open');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    // Only remove this test's verified temporary directory.
    assert.ok(dir.startsWith(path.join(os.tmpdir(),'priority-test-')));
    await fs.rm(dir,{recursive:true,force:true});
  }
});
