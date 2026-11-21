import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../../packages/protocol/src/event-store.js';
import { GitHubReadAdmission } from '../github-read-admission.js';
import type { GitHubReadResponse } from '../github-read-response.js';
const stores: EventStore[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());vi.restoreAllMocks();});
const fixture=()=>{const store=new EventStore(':memory:');stores.push(store);return {q:store.githubReadQuota,a:new GitHubReadAdmission(store.githubReadQuota)};};
const response=(remaining=4999):GitHubReadResponse=>({status:200,headers:{'x-ratelimit-resource':'core','x-ratelimit-limit':'5000','x-ratelimit-remaining':String(remaining),'x-ratelimit-reset':String(Math.floor(Date.now()/1000)+3600)},data:{id:42,login:'owner'}});
const request=(connectionId='one',principalId?:string)=>({connectionId,principalId,background:false,signal:new AbortController().signal,assertCurrent:()=>undefined});
it('attests only a trusted /user response and shares foreground/background charges across connections',async()=>{
  const {q,a}=fixture();
  await a.read('/user',request(),async()=>response());
  await a.read('/repos/o/r',request('two','github:42'),async()=>response());
  await a.read('/repos/o/r',{...request('one','github:42'),background:true},async()=>response());
  expect(q.inspect('github:42')).toMatchObject({charged:3,spent:1,remaining:4997});
});
it('charges transport failure and cancellation and never trusts a supplied principal for identity discovery',async()=>{
  const {q,a}=fixture();
  await a.read('/user',request(),async()=>response());
  await expect(a.read('/repos/o/r',request('one','github:42'),async()=>{throw Error('offline failure');})).rejects.toThrow('offline failure');
  const c=new AbortController();
  await expect(a.read('/repos/o/r',{...request('two','github:42'),signal:c.signal},async()=>{c.abort();return response();})).rejects.toThrow();
  expect(q.inspect('github:42').charged).toBe(3);
  await expect(a.read('/user',request('one','github:999'),async()=>response())).rejects.toThrow('connection_unavailable');
  expect(q.inspect('github:42').charged).toBe(4);
  expect(q.inspect('github:999').charged).toBe(0);
});
it('retains Retry-After with missing/stale metadata and blocks follow-up reads with useful diagnostics',async()=>{
  const {q,a}=fixture();
  await a.read('/user',request(),async()=>response());
  const transport=vi.fn(async()=>({status:429,headers:{},retryAfterMs:120000,data:null}));
  await expect(a.read('/repos/o/r',request('one','github:42'),transport)).rejects.toThrow('quota_delayed');
  expect(q.inspect('github:42').retryAt).toBeGreaterThan(Date.now()+119000);
  await expect(a.read('/repos/o/r',request('two','github:42'),transport)).rejects.toThrow('quota_delayed');
  expect(transport).toHaveBeenCalledTimes(1);
});
it('charges a response before a revoked authority or changed numeric account can return data',async()=>{
  const {q,a}=fixture();
  let current=true;
  await expect(a.read('/user',{...request(),assertCurrent:()=>{if(!current)throw Error('revoked');}},async()=>{current=false;return response();})).rejects.toThrow('revoked');
  expect(q.inspect('github:42').charged).toBe(1);
  await expect(a.read('/user',request('two','github:42'),async()=>({...response(),data:{id:43}}))).rejects.toThrow('connection_unavailable');
  expect(q.inspect('github:43').charged).toBe(1);
});
it('retains failed bootstrap debt until a subsequent authenticated identity is known',async()=>{
  const {q,a}=fixture();
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
  await expect(a.read('/user',request(),async()=>{throw Error('offline');})).rejects.toThrow('offline');
  const read=vi.fn(async()=>response());
  await expect(a.read('/user',request('two'),read)).rejects.toThrow('quota_delayed');
  expect(read).not.toHaveBeenCalled();
  now+=61000;
  await a.read('/user',request('two'),read);
  expect(q.inspect('github:42').charged).toBe(2);
});
