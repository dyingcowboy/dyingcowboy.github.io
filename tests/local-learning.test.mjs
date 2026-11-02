import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { learningMiddleware } from '../src/plugins/local-learning.mjs';

const invoke = async (handler, url, overrides = {}) => {
  let body = '';
  const res = {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(value=''){body=value;}};
  let next = false;
  await handler({url,method:'GET',headers:{host:'127.0.0.1:4321'},socket:{remoteAddress:'127.0.0.1'},...overrides},res,()=>{next=true;});
  return {...res,body,next};
};
test('本机API限制来源与方法，目录不构成可读路径，视图不携带正文', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'learning-api-'));
  try {
    const stateFile = path.join(dir,'state.json');
    await writeFile(stateFile, JSON.stringify({sources:{privatePath:'SECRET'},archive:{version:1,trajectories:[]},view:{version:1,projectionVersion:1,generatedAt:'now',projects:[],notes:[{id:'one',title:'note',body:'PRIVATE',html:'<p>PRIVATE</p>'}]}}));
    const handler = learningMiddleware(stateFile);
    const view = await invoke(handler,'/__learning/view.json');
    assert.equal(view.statusCode,200);
    assert.doesNotMatch(view.body,/PRIVATE|SECRET|privatePath/);
    assert.equal((await invoke(handler,'/__learning/notes/one.json')).statusCode,200);
    assert.equal((await invoke(handler,'/__learning/../../state.json')).statusCode,404);
    assert.equal((await invoke(handler,'/__learning/archive.json',{method:'POST'})).statusCode,405);
    assert.equal((await invoke(handler,'/__learning/archive.json',{socket:{remoteAddress:'192.168.1.2'}})).statusCode,403);
    assert.equal((await invoke(handler,'/__learning/archive.json',{headers:{host:'evil.example'}})).statusCode,403);
    assert.equal((await invoke(handler,'/__learning/archive.json',{headers:{host:'127.0.0.1:4321',origin:'https://evil.example'}})).statusCode,403);
    assert.equal((await invoke(handler,'/learning/')).next,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
