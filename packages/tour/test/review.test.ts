import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Unanswered} from '@pagebeam/model';
import {parseConfig,reviewDecisionSchema} from '@pagebeam/core';
import {reviewCaptures,ReviewFailure,compareReviewRuns} from '../dist/review.js';
import {capture} from '../dist/capture.js';
import {reviewContext,navigationSources} from '../dist/review-context.js';
import {comparePixels,learnVolatility} from '../dist/pixels.js';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {PublicResources} from '../dist/index.js';

const exec=promisify(execFile);
const fixtures=path.join(import.meta.dirname,'fixtures/review-root');
async function project(){
  const cwd=await mkdtemp(path.join(tmpdir(),'pagebeam-review-test-'));
  await writeFile(path.join(cwd,'package.json'),'{"name":"field-catalogue","type":"module"}');
  await writeFile(path.join(cwd,'index.html'),await readFile(path.join(fixtures,'before.html')));
  for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@example.test'],['add','.'],['-c','commit.gpgsign=false','commit','-qm','test: Add catalogue fixture']])await exec('git',args,{cwd});
  const base=(await exec('git',['rev-parse','HEAD'],{cwd})).stdout.trim();
  await writeFile(path.join(cwd,'index.html'),await readFile(path.join(fixtures,'after.html')));
  await exec('git',['add','.'],{cwd});await exec('git',['-c','commit.gpgsign=false','commit','-qm','ui: Update catalogue filters and basket'],{cwd});
  const head=(await exec('git',['rev-parse','HEAD'],{cwd})).stdout.trim();
  return{cwd,base,head};
}
async function serve(file:string){
  const html=await readFile(file);
  const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');
  return{url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
function settings(head:string,base:string,url='http://127.0.0.1:1',before=url){
  return parseConfig({model:{baseUrl:'https://example.test/v1',name:'recorded',sendSource:true},tours:{targets:{head:{url},base:{url:before}},accounts:{visitor:{purpose:'Public catalogue visitor',login:{anonymous:true},confirm:'h1'}},timeoutMs:1500},capture:{discovery:{maxDecisions:6,timeoutMs:30000},environments:{head:{backend:{kind:'none'},frontendRevision:head,disposable:true},base:{backend:{kind:'none'},frontendRevision:base,disposable:true}}}});
}

for(const diffImages of [false,true])test(`automatic review discovers and replays both revisions with difference images ${diffImages?'enabled':'disabled'}`,async()=>{
  const {cwd,head,base}=await project();
  const after=await serve(path.join(fixtures,'after.html')),before=await serve(path.join(fixtures,'before.html'));
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8')) as {purpose:string;input:Record<string,string>;output:unknown}[];
  const used=new Set<number>();let calls=0,relatedTraces=0;
  const config=settings(head,base,after.url,before.url);config.model!.apiKeyEnv='REVIEW_MODEL_KEY_TEST';
  process.env.REVIEW_MODEL_KEY_TEST='your-api-key-here';
  config.capture!.environments.head!.prepare=["node -e 'if(process.env.REVIEW_MODEL_KEY_TEST)process.exit(99)'"];
  try{
    const result=await reviewCaptures({cwd,config,environment:'head',target:'head',compareEnvironment:'base',compareTarget:'base',base,html:true,...(diffImages?{diffImages:true}:{}),judge:async(purpose,_system,input)=>{
      calls++;
      if(purpose==='navigate'&&Array.isArray((input as {related?:unknown[]}).related)&&(input as {related:unknown[]}).related.length)relatedTraces++;
      const request=input as Record<string,string>;
      const index=recorded.findIndex((entry,index)=>!used.has(index)&&entry.purpose===purpose&&(purpose!=='navigate'||['goal','side','viewport'].every(key=>entry.input[key]===request[key])));
      assert.ok(index>=0,`Unrecorded judgment request: ${JSON.stringify(input)}`);
      used.add(index);return JSON.stringify(recorded[index]!.output);
    }});
    assert.equal(result.outcome.status,'passed');
    assert.equal(result.comparison?.compatible,true);
    assert.equal(result.outcome.captures.length,4);
    assert.equal(Object.keys(settings(head,base).tours!.journeys).length,0);
    assert.equal(result.outcome.coverage?.basis,'model');
    assert.equal(result.stability!.length,4);
    assert.ok(result.stability!.every(state=>state.valid&&state.controlPixels===0));
    assert.ok(result.differences!.some(state=>state.pixels>0));
    assert.ok(calls<=recorded.length,'Replay must not introduce additional model decisions');
    assert.ok(relatedTraces>0,'Navigation should receive successful same-revision sibling paths');
    assert.ok(result.recipe.states.every(state=>state.head.every(step=>!JSON.stringify(step).includes('data-pagebeam-control'))));
    assert.ok(result.recipe.states.some(state=>JSON.stringify(state.head)!==JSON.stringify(state.base)));
    assert.ok((await readFile(result.markdown,'utf8')).includes('(model assessment)'));
    const tampered=structuredClone(result.recipe);tampered.states[0]!.goal='A different review state';
    assert.equal(compareReviewRuns(result.head,result.base!,tampered).compatible,false);
    assert.equal(result.outcome.diffImages,diffImages);
    assert.ok(result.outcome.captures.every(shot=>Boolean(shot.diff)===diffImages));
    assert.ok(result.differences!.every(shot=>Boolean(shot.diff)===diffImages));
    assert.equal((await readFile(result.markdown,'utf8')).includes('| Difference |'),diffImages);
  }finally{delete process.env.REVIEW_MODEL_KEY_TEST;await Promise.all([after.close(),before.close()]);}
});

test('no-UI review starts no services and makes no model calls',async()=>{
  const {cwd,head,base}=await project();
  const config=settings(head,base);config.capture!.environments.head!.prepare=['exit 99'];
  let calls=0;
  const result=await reviewCaptures({cwd,config,environment:'head',target:'head',changed:['README.md'],judge:async()=>{calls++;throw new Error('Must not call a model');}});
  assert.equal(calls,0);assert.equal(result.outcome.coverage?.status,'no-ui');assert.equal(result.head.report.backend,undefined);assert.deepEqual(result.outcome.captures,[]);
});

test('invalid model plans produce a native incomplete outcome instead of capture success',async()=>{
  const {cwd,head,base}=await project();
  const entries=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  const plan=entries.find((entry:any)=>entry.purpose==='plan').output;plan.states[0].account='unconfigured-account';
  let failure:ReviewFailure|undefined;
  try{await reviewCaptures({cwd,config:settings(head,base),environment:'head',target:'head',base,judge:async(purpose)=>JSON.stringify(purpose==='changes'?entries.find((entry:any)=>entry.purpose==='changes').output:plan)});}catch(error){assert.ok(error instanceof ReviewFailure);failure=error;}
  assert.ok(failure);const outcome=JSON.parse(await readFile(failure.evidence.manifest,'utf8'));
  assert.equal(outcome.status,'incomplete');assert.equal(outcome.head.revision,head);assert.deepEqual(outcome.captures,[]);
});

test('model review actions cannot execute scripts, read environment values or decide screenshot execution',()=>{
  for(const action of [{verify:'arbitrary.mjs'},{fill:{selector:'input',valueEnv:'SECRET'}},{shot:{name:'arbitrary'}}])assert.equal(reviewDecisionSchema.safeParse({actions:[action],done:false,assertions:[]}).success,false);
  assert.equal(reviewDecisionSchema.safeParse({actions:[],done:true,assertions:[]}).success,false);
});

test('volatile pixels are bounded and independently checked against held-out screenshots',async()=>{
  const {PNG}=createRequire(import.meta.url)('pngjs');
  const cwd=await mkdtemp(path.join(tmpdir(),'pagebeam-pixels-test-'));
  const image=(pixels:number[])=>{const data=Buffer.alloc(32*32*4,255);for(const index of pixels){data[index*4]=0;data[index*4+1]=0;data[index*4+2]=0;}return PNG.sync.write({width:32,height:32,data});};
  const names=['reference','blink','holdout','new-change'];
  for(const [index,pixels]of [[],[32+1],[32+1],[32+1,32+4]].entries())await writeFile(path.join(cwd,names[index]!+'.png'),image(pixels));
  const reference=path.join(cwd,'reference.png'),blink=path.join(cwd,'blink.png');
  const learned=await learnVolatility(reference,[blink],path.join(cwd,'holdout.png'));
  assert.equal(learned.valid,true);assert.equal(learned.volatilePixels,1);
  assert.equal((await learnVolatility(reference,[blink])).valid,false);
  assert.equal((await comparePixels(reference,blink,undefined,learned.mask)).pixels,0);
  assert.equal((await learnVolatility(reference,[blink],path.join(cwd,'new-change.png'))).valid,false);
});


test('a provider outage after discovering a state retains its native screenshot evidence',async()=>{
  const {cwd,head,base}=await project();
  const after=await serve(path.join(fixtures,'after.html')),before=await serve(path.join(fixtures,'before.html'));
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  let navigationCalls=0;
  try{
    const result=await reviewCaptures({cwd,config:settings(head,base,after.url,before.url),environment:'head',target:'head',compareEnvironment:'base',compareTarget:'base',base,judge:async(purpose)=>{
      if(purpose==='navigate'&&++navigationCalls>1)throw new Unanswered('provider unavailable');
      return JSON.stringify(recorded.find((entry:any)=>entry.purpose===purpose).output);
    }});
    assert.equal(result.outcome.status,'incomplete');
    assert.ok(result.outcome.captures.some(shot=>shot.head));
    assert.ok(result.outcome.evidence.some(item=>item.mediaType==='image/png'));
    assert.ok(result.outcome.coverage?.reasons.some(reason=>reason.includes('provider unavailable')));
    assert.ok(navigationCalls>2,'An isolated provider failure must not cancel every remaining state');
  }finally{await Promise.all([after.close(),before.close()]);}
});


test('review context isolates applications sharing a route and retains imported workspace sources',async()=>{
  const {cwd,head,base}=await project();
  const sources={
    'apps/alpha/package.json':'{"name":"alpha"}',
    'apps/alpha/nuxt.config.ts':'export default defineNuxtConfig({})',
    'apps/alpha/app/pages/index.vue':"<script setup>import {title} from '../../../../shared/title.ts'</script><template>{{title}}</template>",
    'apps/beta/package.json':'{"name":"beta"}',
    'apps/beta/nuxt.config.ts':'export default defineNuxtConfig({})',
    'apps/beta/app/pages/index.vue':'<template>Other application</template>',
    'shared/title.ts':"export const title='Catalogue'",
    'shared/optional.ts':"export const optional='Unresolved shared behavior'",
    'apps/alpha/backend/catalogue_test.go':'package catalogue',
  };
  for(const [file,text]of Object.entries(sources)){await mkdir(path.dirname(path.join(cwd,file)),{recursive:true});await writeFile(path.join(cwd,file),text);}
  const config=settings(head,base);config.capture!.impact={root:'apps/alpha',ignore:[],global:[],routes:{},maxJourneys:6};
  const changed=['apps/alpha/app/pages/index.vue','apps/beta/app/pages/index.vue','shared/title.ts','shared/optional.ts','apps/alpha/backend/catalogue_test.go'];
  const context=await reviewContext({cwd,config,changed});
  assert.deepEqual(context.changed.sort(),['apps/alpha/app/pages/index.vue','shared/optional.ts','shared/title.ts']);
  assert.deepEqual(context.routes,['/']);
  assert.ok(context.surfaces.some(surface=>surface.route==='/'&&surface.files.includes('shared/title.ts')));
  assert.ok(!context.surfaces.some(surface=>surface.files.some(file=>file.startsWith('apps/beta/'))));
  assert.ok(context.ignored.includes('apps/beta/app/pages/index.vue'));
  assert.ok(context.ignored.includes('apps/alpha/backend/catalogue_test.go'));
  assert.ok(!context.source.some(source=>source.path.includes('beta')));
});


test('browser observations exclude actionable controls behind an open modal',async()=>{
  const {cwd,head,base}=await project();
  const app=await serve(path.join(fixtures,'after.html'));
  const original=settings(head,base,app.url);
  const config=parseConfig({...original,tours:{...original.tours,journeys:{inspect:{account:'visitor',steps:[],explore:{goal:'Inspect basket dialog',actions:['goto','click','expect'],allowChanges:true,maxActions:10,timeoutMs:10000}}}}});
  try{
    const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'caller'},async session=>{
      await session.step({goto:'/'});
      assert.ok((await session.observe()).controls.some(control=>control.attributes?.id==='filters'));
      await session.step({expect:{selector:'button',text:'Basket',visibleText:true}});
      await session.step({click:'#basket'});
      await session.step({expect:{selector:'#basket-dialog',text:'Review your basket'}});
      const observation=await session.observe();
      assert.ok(observation.controls.some(control=>control.attributes?.id==='close-basket'));
      assert.ok(!observation.controls.some(control=>control.attributes?.id==='filters'));
      assert.ok(!observation.controls.some(control=>control.attributes?.id==='basket'));
    });
    assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));
  }finally{await app.close();}
});


test('navigation receives actual source from the corresponding revision',async()=>{
  const {cwd,base}=await project();
  const after=await navigationSources(cwd,['index.html']);
  const before=await navigationSources(cwd,['index.html'],base);
  assert.ok(after[0]!.text.includes('Refine catalogue'));
  assert.ok(!before[0]!.text.includes('Refine catalogue'));
  assert.ok(before[0]!.text.includes('<h2>Categories</h2>'));
  assert.deepEqual(await navigationSources(cwd,['../outside.html']),[]);
});


test('screenshot assertions reject clipped controls until the browser scrolls them into view',async()=>{
  const {cwd,head,base}=await project();
  const file=path.join(cwd,'clipped.html');
  await writeFile(file,'<!doctype html><style>body{margin:0;min-height:200px}button{position:absolute;top:142px;left:12px;height:40px;width:100px}</style><h1>Catalogue</h1><button id="basket">Basket</button>');
  const app=await serve(file);
  const original=settings(head,base,app.url);
  const config=parseConfig({...original,tours:{...original.tours,journeys:{inspect:{account:'visitor',viewports:[{name:'desktop',width:390,height:180}],steps:[],explore:{goal:'Inspect basket button',actions:['goto','scroll','expect'],allowChanges:true,maxActions:10,timeoutMs:10000}}}}});
  try{
    const failed=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'caller'},async session=>{
      await session.step({goto:'/'});
      await session.step({expect:{selector:'#basket',text:'Basket',inViewport:true}});
    });
    assert.notEqual(failed.report.status,'passed');
    assert.ok(failed.report.results.some(result=>result.error?.includes('outside the screenshot frame')),JSON.stringify(failed.report.errors));
    const passed=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'caller'},async session=>{
      await session.step({goto:'/'});
      await session.step({scroll:{y:5000,x:0}});
      await session.step({expect:{selector:'#basket',text:'Basket',inViewport:true}});
    });
    assert.equal(passed.report.status,'passed',JSON.stringify(passed.report.errors));
  }finally{await app.close();}
});


test('source-based judgment without permitted source fails before services or model requests',async()=>{
  const {cwd,head,base}=await project();
  const config=settings(head,base);config.model!.sendSource=false;
  config.capture!.environments.head!.prepare=['exit 99'];
  await assert.rejects(reviewCaptures({cwd,config,environment:'head',target:'head',base}),error=>error instanceof ReviewFailure&&error.message.includes('No permitted source excerpts'));
});


test('baseline startup failure retains completed head screenshots in the native outcome',async()=>{
  const {cwd,head,base}=await project();
  const app=await serve(path.join(fixtures,'after.html'));
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  const used=new Set<number>();
  const config=settings(head,base,app.url);config.capture!.environments.base!.prepare=['exit 99'];
  let failure:ReviewFailure|undefined;
  try{
    await reviewCaptures({cwd,config,environment:'head',target:'head',compareEnvironment:'base',compareTarget:'base',base,judge:async(purpose,_system,input)=>{
      const request=input as Record<string,string>;
      const index=recorded.findIndex((entry:any,index:number)=>!used.has(index)&&entry.purpose===purpose&&(purpose!=='navigate'||['goal','side','viewport'].every(key=>entry.input[key]===request[key])));
      assert.ok(index>=0);used.add(index);return JSON.stringify(recorded[index]!.output);
    }});
  }catch(error){assert.ok(error instanceof ReviewFailure);failure=error;}
  finally{await app.close();}
  assert.ok(failure);
  const outcome=JSON.parse(await readFile(failure.evidence.manifest,'utf8'));
  assert.equal(outcome.status,'incomplete');assert.equal(outcome.compatible,false);
  assert.equal(outcome.captures.filter((shot:any)=>shot.head).length,4);
  assert.ok(outcome.evidence.some((item:any)=>item.mediaType==='image/png'));
});


test('input expectations use form values and replay from the frozen browser step',async()=>{
  const {cwd,head,base}=await project();
  const file=path.join(cwd,'form.html');
  await writeFile(file,'<!doctype html><h1>Catalogue settings</h1><label>Title <input id="title" value="Field catalogue"></label>');
  const app=await serve(file);
  const original=settings(head,base,app.url);
  const config=parseConfig({...original,tours:{...original.tours,journeys:{inspect:{account:'visitor',steps:[],explore:{goal:'Inspect catalogue title',actions:['goto','expect'],maxActions:10,timeoutMs:10000}}}}});
  let frozen:any;
  try{
    const discovered=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'caller'},async session=>{
      await session.step({goto:'/'});
      frozen=await session.stableStep({expect:{selector:'#title',text:'Field catalogue',visibleText:true,inViewport:true}});
      assert.equal(frozen.expect.text,undefined);assert.equal(frozen.expect.value,'Field catalogue');
      await session.step(frozen);
    });
    assert.equal(discovered.report.status,'passed',JSON.stringify(discovered.report.errors));
    config.tours!.journeys.inspect!.steps=[{goto:'/'},frozen];
    const replayed=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved'});
    assert.equal(replayed.report.status,'passed',JSON.stringify(replayed.report.errors));
  }finally{await app.close();}
});


test('model plans may repeat known changed files that static analysis already excluded',async()=>{
  const {cwd,head,base}=await project();
  await writeFile(path.join(cwd,'README.md'),'Catalogue documentation');
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  const controller=new AbortController();let plans=0;let directory:string|undefined;
  try{
    const result=await reviewCaptures({cwd,config:settings(head,base),environment:'head',target:'head',base,changed:['index.html','README.md'],signal:controller.signal,judge:async(purpose)=>{
      const value=structuredClone(recorded.find((entry:any)=>entry.purpose===purpose).output);
      if(purpose==='plan'){plans++;value.ignored.push({file:'README.md',reason:'Documentation is outside the visual review'});controller.abort();}
      return JSON.stringify(value);
    }});
    directory=result.directory;
  }catch(error){assert.ok(error instanceof ReviewFailure);directory=error.evidence.directory;}
  const recipe=JSON.parse(await readFile(path.join(directory!,'recipe.json'),'utf8'));
  assert.ok(recipe.plan.ignored.some((item:any)=>item.file==='README.md'));
  assert.equal(plans,1);
});

test('automatic review expands shortened source before keeping a missing-evidence classification',async()=>{
  const {cwd,head,base}=await project();
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  const original=recorded.find((entry:any)=>entry.purpose==='changes').output;
  const extra=Array.from({length:12},(_,index)=>`extra-${index}.ts`);
  for(const file of extra)await writeFile(path.join(cwd,file),`export const source=${JSON.stringify('context'.repeat(2000))};`);
  const backend='package fixture\nvar source = '+JSON.stringify('context'.repeat(700))+'\n';
  await writeFile(path.join(cwd,'backend.go'),backend);
  let changes=0;
  await assert.rejects(()=>reviewCaptures({cwd,config:settings(head,base),environment:'head',target:'head',changed:['index.html',...extra,'backend.go'],judge:async(purpose,_system,value)=>{
    if(purpose==='plan')throw new Error('Stop after source expansion');
    assert.equal(purpose,'changes');changes++;
    const input=value as {source:{path:string;text:string}[]};
    const source=input.source.find(source=>source.path==='backend.go');assert.ok(source);
    if(changes===1)assert.ok(source.text.includes('[Source excerpt shortened]'));
    else assert.equal(source.text,backend);
    return JSON.stringify({...original,ignored:[...original.ignored,...extra.map(file=>({file,reason:'No visible application dependency'})),...(changes>1?[{file:'backend.go',reason:'No visible application dependency'}]:[])],unresolved:changes===1?[{file:'backend.go',reason:'Source excerpt shortened'}]:[]});
  }}),/Stop after source expansion/);
  assert.equal(changes,2);
});

test('isolated replay restores HTTP fixtures before each journey',async()=>{
  const {cwd,head,base}=await project();let count=0,restores=0;
  const server=createServer((request,response)=>{
    if(request.method==='POST'&&request.url==='/restore'){count=0;restores++;response.end();return;}
    if(request.method==='POST'&&request.url==='/increment'){response.setHeader('content-type','application/json');response.end(JSON.stringify({count:++count}));return;}
    response.setHeader('content-type','text/html');response.end(`<h1>Counter</h1><button id="increment">Increment</button><output id="count">0</output><script>document.querySelector('button').onclick=async()=>{const response=await fetch('/increment',{method:'POST'});document.querySelector('output').textContent=(await response.json()).count}</script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  await writeFile(path.join(cwd,'restore.mjs'),`const response=await fetch(${JSON.stringify(url+'/restore')},{method:'POST'});if(!response.ok)throw new Error('Restore failed')`);
  const original=settings(head,base,url);
  const journey={account:'visitor',steps:[{goto:'/'},{click:'#increment'},{expect:{selector:'#count',text:'1'}},{shot:{name:'counter',route:'/',fullPage:false}}]};
  const config=parseConfig({...original,tours:{...original.tours,journeys:{first:journey,second:journey}},capture:{...original.capture,environments:{head:{...original.capture!.environments.head,fixtures:{version:'counter-v1',restore:'node restore.mjs'}}}}});
  try{
    const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',restoreFixtures:true});
    assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));assert.equal(count,1);assert.equal(restores,3);
    const shots=result.report.results.map(result=>path.join(result.journey,result.viewport,result.steps.find(step=>step.action==='shot')!.file!));
    assert.equal((await comparePixels(path.join(result.directory,shots[0]!),path.join(result.directory,shots[1]!))).pixels,0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('automatic plans cannot replace responsive or expanded-control coverage with default desktop shots',async()=>{
  const {cwd,head,base}=await project();
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  const changes=recorded.find((entry:any)=>entry.purpose==='changes').output;
  const original=recorded.find((entry:any)=>entry.purpose==='plan').output;
  const config=settings(head,base);
  const context=await reviewContext({cwd,config,base});assert.ok(context.responsiveFiles.includes('index.html'));
  for(const variant of ['responsive','interaction','error','default','responsive-default']){
    const plan=structuredClone(original);
    for(const state of plan.states){if(variant==='responsive')state.viewports=['desktop'];else if(variant==='interaction')state.kind='default';}
    if(variant==='error')plan.states[0].kind='error';
    if(variant==='default')for(const state of plan.states.filter((state:any)=>state.intents.includes('filter-trigger-label')))state.kind='interaction';
    if(variant==='responsive-default')plan.states[1].intents=plan.states[1].intents.filter((intent:string)=>intent!=='filter-trigger-label');
    await assert.rejects(()=>reviewCaptures({cwd,config,environment:'head',target:'head',base,judge:async(purpose)=>JSON.stringify(purpose==='changes'?changes:plan)}),variant==='responsive'?/Responsive layout.*representative phone and desktop/:variant==='interaction'?/requires a nondefault interaction or error state/:variant==='default'?/Default change.*requires a separate default or error state/:variant==='responsive-default'?/Responsive default change.*initial unmodified view/:/Responsive error state.*phone and desktop/);
  }
});

test('still review disables moving controls before navigation actions',async()=>{
  const {cwd,head,base}=await project();
  const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(`<style>@keyframes moving{from{transform:translateX(0)}to{transform:translateX(200px)}}button{animation:moving .2s linear infinite alternate}</style><h1>Animated control</h1><button id="open" onclick="document.querySelector('dialog').showModal()">Open details</button><dialog><h2>Details</h2></dialog>`);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  const original=settings(head,base,url);
  const config=parseConfig({...original,tours:{...original.tours,timeoutMs:1500,journeys:{details:{account:'visitor',record:false,steps:[{goto:'/'},{click:'#open'},{expect:{selector:'dialog',text:'Details'}},{shot:{name:'details',route:'/',fullPage:false}}]}}}});
  try{
    const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',clock:'2024-01-01T00:00:00.000Z'});
    assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('browser readiness waits for the page to complete two layout frames',async()=>{
  const {cwd,head,base}=await project();
  const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(`<h1>Waiting for layout</h1><script>const nativeFrame=window.requestAnimationFrame.bind(window);let frames=0;window.requestAnimationFrame=callback=>nativeFrame(time=>{if(++frames===2)document.querySelector('h1').textContent='Layout ready';callback(time)})</script>`);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  const original=settings(head,base,url);
  const config=parseConfig({...original,tours:{...original.tours,journeys:{layout:{account:'visitor',record:false,steps:[],explore:{goal:'Read the completed layout',actions:['goto','expect','shot'],maxActions:5,timeoutMs:10000}}}}});
  try{
    const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'caller'},async session=>{
      await session.step({goto:'/'});await session.ready();await session.step({expect:{selector:'h1',text:'Layout ready'}});await session.step({shot:{name:'ready',route:'/',fullPage:false}});
    });
    assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('calibration waits for a partially rendered panel to settle',async()=>{
  const {cwd,head,base}=await project();
  const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(`<h1>Async panel</h1><div id="panel" style="width:200px;height:200px;background:rgb(255,0,0)"></div><script>setTimeout(()=>document.querySelector('#panel').style.background='rgb(0,128,0)',1200)</script>`);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  const original=settings(head,base,url);
  const config=parseConfig({...original,tours:{...original.tours,timeoutMs:5000,journeys:{panel:{account:'visitor',record:false,steps:[{goto:'/'},{wait:'#panel'},{shot:{name:'panel',route:'/',fullPage:false}}]}}}});
  try{
    const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',calibrate:true,clock:'2024-01-01T00:00:00.000Z'});
    assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));
    const state=result.report.results[0]!,shot=state.steps.find(step=>step.action==='shot')!;
    const {PNG}=createRequire(import.meta.url)('pngjs');const image=PNG.sync.read(await readFile(path.join(result.directory,state.journey,state.viewport,shot.file!)));
    assert.deepEqual([...image.data.subarray((300*image.width+200)*4,(300*image.width+200)*4+4)],[0,128,0,255]);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('learned label clicks bind to their control across regenerated child identifiers',async()=>{
  const {cwd,head,base}=await project();let sequence=0;
  const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(`<h1>Record chooser</h1><button id="choose"><span id="label-${++sequence}">Choose record</span></button><output id="state">Waiting</output><script>document.querySelector('button').onclick=()=>document.querySelector('output').textContent='Selected'</script>`);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  const original=settings(head,base,url);let normalized:any;
  const config=parseConfig({...original,tours:{...original.tours,journeys:{choose:{account:'visitor',record:false,steps:[],explore:{goal:'Choose a record',allowChanges:true,actions:['goto','click','expect','shot'],maxActions:10,timeoutMs:10000}}}}});
  try{
    const learned=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'caller'},async session=>{
      await session.step({goto:'/'});const label=/id="(label-\d+)"/.exec((await session.observe()).structure!);assert.ok(label);
      normalized=await session.stableStep({click:'#'+label[1]});await session.step(normalized);await session.step({expect:{selector:'#state',text:'Selected'}});await session.step({shot:{name:'selected',route:'/',fullPage:false}});
    });
    assert.equal(learned.report.status,'passed',JSON.stringify(learned.report.errors));
    config.tours!.journeys.choose!.steps=[{goto:'/'},normalized,{expect:{selector:'#state',text:'Selected'}},{shot:{name:'selected',route:'/',fullPage:false,focus:[]}}];
    const replay=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved'});
    assert.equal(replay.report.status,'passed',JSON.stringify(replay.report.errors));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('a failed replay gets one fresh discovery pass with its failed trace retained',async()=>{
  const {cwd,head,base}=await project();const html=await readFile(path.join(fixtures,'after.html'),'utf8');let broken=false;
  const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(broken?html.replace('</body>',`<script>document.querySelector('#filters').remove()</script></body>`):html);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  const before=await serve(path.join(fixtures,'before.html'));
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  const fullPlan=recorded.find((entry:any)=>entry.purpose==='plan').output,states=fullPlan.states.slice(0,2),intents=new Set(states.flatMap((state:any)=>state.intents));
  const fullChanges=recorded.find((entry:any)=>entry.purpose==='changes').output;
  const used=new Set<number>(),completed=new Set<string>();let repairs=0;
  try{
    const result=await reviewCaptures({cwd,config:settings(head,base,url,before.url),environment:'head',target:'head',compareEnvironment:'base',compareTarget:'base',base,judge:async(purpose,_system,value)=>{
      if(purpose==='changes')return JSON.stringify({...fullChanges,changes:fullChanges.changes.filter((change:any)=>intents.has(change.id))});
      if(purpose==='plan')return JSON.stringify({...fullPlan,states});
      const input=value as any;
      if(input.previousRecipe){
        repairs++;broken=false;
        return JSON.stringify({actions:input.previousRecipe.filter((step:any)=>!('expect'in step)&&!('shot'in step)),done:true,assertions:input.previousRecipe.filter((step:any)=>'expect'in step).map((step:any)=>({selector:step.expect.selector,text:step.expect.text,value:step.expect.value}))});
      }
      const index=recorded.findIndex((entry:any,index:number)=>!used.has(index)&&entry.purpose===purpose&&['goal','side','viewport'].every(key=>entry.input[key]===input[key]));assert.ok(index>=0);used.add(index);
      const output=recorded[index].output;
      if(input.side==='head'&&output.done){completed.add(input.goal+'|'+input.viewport);if(completed.size===2)broken=true;}
      return JSON.stringify(output);
    }});
    assert.equal(result.outcome.status,'passed',JSON.stringify(result.outcome.reasons));assert.equal(result.comparison?.compatible,true);assert.equal(repairs,1);
    assert.equal(result.recipe.repairs?.length,1);assert.ok(result.outcome.evidence.some(item=>item.id==='replay-repairs'));
    const failed=JSON.parse(await readFile(path.join(result.directory,result.recipe.repairs![0]!.failedRun,'report.json'),'utf8'));assert.equal(failed.status,'failed');
  }finally{await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),before.close()]);}
});

test('review navigation prepares the account then opens the requested state once',async()=>{
  const {cwd,head,base}=await project();let landing=0,details=0;
  const server=createServer((request,response)=>{if(request.url==='/')landing++;if(request.url==='/details')details++;response.setHeader('content-type','text/html');response.end(`<h1>${request.url==='/details'?'Requested state':'Account landing'}</h1>`);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  const original=settings(head,base,url);
  const config=parseConfig({...original,tours:{...original.tours,journeys:{details:{account:'visitor',record:false,steps:[{goto:'/details'},{expect:{selector:'h1',text:'Requested state'}},{shot:{name:'details',route:'/details',fullPage:false}}]}}}});
  try{
    const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',deferNavigation:true});
    assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));assert.equal(landing,1);assert.equal(details,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('public resource snapshots freeze rendering assets without caching private or live data',async()=>{
  const {cwd,head,base}=await project();let assets=0,privateAssets=0,data=0;
  const server=createServer((request,response)=>{
    if(request.url==='/asset.js'){response.setHeader('content-type','application/javascript');response.setHeader('cache-control','public, max-age=3600');response.setHeader('content-encoding','gzip');response.end(gzipSync(`document.querySelector('#asset').textContent='Asset ${++assets}'`));return;}
    if(request.url==='/private.js'){privateAssets++;response.setHeader('content-type','application/javascript');response.setHeader('cache-control','private, no-store');response.end('window.privateAsset=true');return;}
    if(request.url==='/data.json'){data++;response.setHeader('content-type','application/json');response.setHeader('cache-control','public, max-age=3600');response.end('{"live":true}');return;}
    response.setHeader('content-type','text/html');response.end(`<h1 id="asset">Loading</h1><script src="/asset.js"></script><script src="/private.js"></script><script>fetch('/data.json')</script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
  const original=settings(head,base,url),store=new PublicResources();
  const config=parseConfig({...original,tours:{...original.tours,journeys:{asset:{account:'visitor',record:false,steps:[{goto:'/'},{expect:{selector:'#asset',text:'Asset 1'}},{shot:{name:'asset',route:'/',fullPage:false}}]}}}});
  try{
    for(let index=0;index<2;index++){
      const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',resources:{store,scope:'head'}});assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));
    }
    assert.equal(assets,1);assert.ok(privateAssets>1);assert.ok(data>1);assert.equal(store.manifest().length,1);
    config.tours!.journeys.asset!.steps=[{goto:'/'},{expect:{selector:'#asset',text:'Asset 2'}},{shot:{name:'asset',route:'/',fullPage:false,focus:[]}}];
    const baseline=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',resources:{store,scope:'base'}});assert.equal(baseline.report.status,'passed',JSON.stringify(baseline.report.errors));assert.equal(assets,2);assert.equal(store.manifest().length,2);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('a missed discovery state reuses a successful sibling without another model decision',async()=>{
  const {cwd,head,base}=await project();const after=await serve(path.join(fixtures,'after.html')),before=await serve(path.join(fixtures,'before.html'));
  const recorded=JSON.parse(await readFile(path.join(fixtures,'decisions.json'),'utf8'));
  const originalPlan=recorded.find((entry:any)=>entry.purpose==='plan').output,state=structuredClone(originalPlan.states[0]);state.viewports=['desktop','phone'];
  const originalChanges=recorded.find((entry:any)=>entry.purpose==='changes').output;
  const decision=(side:string)=>recorded.find((entry:any)=>entry.purpose==='navigate'&&entry.input.side===side&&entry.input.goal===(side==='head'?state.goal:state.before??state.goal)&&entry.output.done).output;
  let headCalls=0,repairCalls=0;
  try{
    const result=await reviewCaptures({cwd,config:settings(head,base,after.url,before.url),environment:'head',target:'head',compareEnvironment:'base',compareTarget:'base',base,judge:async(purpose,_system,value)=>{
      if(purpose==='changes')return JSON.stringify({...originalChanges,changes:originalChanges.changes.filter((change:any)=>state.intents.includes(change.id))});
      if(purpose==='plan')return JSON.stringify({...originalPlan,states:[state]});
      const input=value as any;if(input.previousRecipe)repairCalls++;
      if(input.side==='head'&&++headCalls===1)throw new Unanswered('temporary discovery failure');
      return JSON.stringify(decision(input.side));
    }});
    assert.equal(result.outcome.status,'passed',JSON.stringify(result.outcome.reasons));assert.equal(headCalls,2);assert.equal(repairCalls,0);assert.equal(result.recipe.repairs?.length,1);
    const status=JSON.parse(await readFile(path.join(result.directory,'discovery-status.json'),'utf8'));assert.deepEqual(status.discoveryFailures,[]);
  }finally{await Promise.all([after.close(),before.close()]);}
});

test('public resource snapshots exclude credentialed requests and responses',async()=>{
  const {cwd,head,base}=await project();
  for(const mode of ['request','response']){
    let assets=0;const assetCookies:string[]=[];
    const server=createServer((request,response)=>{
      if(request.url==='/asset.js'){assetCookies.push(request.headers.cookie??'');assets++;response.setHeader('content-type','application/javascript');response.setHeader('cache-control','public, max-age=3600');if(mode==='response')response.setHeader('set-cookie','auth_fixture=present; Path=/; SameSite=Lax');response.end('window.loaded=true');return;}
      response.setHeader('content-type','text/html');if(mode==='request')response.setHeader('set-cookie','auth_fixture=present; Path=/; SameSite=Lax');response.end('<h1>Private asset</h1><script src="/asset.js"></script>');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`,store=new PublicResources(),original=settings(head,base,url);
    const config=parseConfig({...original,tours:{...original.tours,journeys:{asset:{account:'visitor',record:false,steps:[{goto:'/'},{shot:{name:'asset',route:'/',fullPage:false}}]}}}});
    try{
      for(let index=0;index<2;index++){const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',resources:{store,scope:'head'}});assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));}
      assert.ok(assets>1);if(mode==='request')assert.ok(assetCookies.every(cookie=>cookie.includes('auth_fixture=present')),JSON.stringify(assetCookies));assert.equal(store.manifest().length,0,mode);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});

test('public resource snapshots respect actual response variants',async(t)=>{
  const {cwd,head,base}=await project();let theme='red',assets=0;
  const server=createServer((request,response)=>{
    if(request.url==='/theme.css'){assets++;response.setHeader('content-type','text/css');response.setHeader('cache-control','public, max-age=3600');response.setHeader('vary','X-Style');response.end(`.theme{color:${request.headers['x-style']}}`);return;}
    response.setHeader('content-type','text/html');response.end(`<h1 id="theme">Loading</h1><script>fetch('/theme.css',{headers:{'x-style':${JSON.stringify(theme)}}}).then(response=>response.text()).then(text=>document.querySelector('#theme').textContent=text)</script>`);
  });
  t.after(async()=>{if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`,store=new PublicResources(),original=settings(head,base,url);
  const config=parseConfig({...original,tours:{...original.tours,journeys:{theme:{account:'visitor',record:false,steps:[{goto:'/'}]}}}});
  try{
    for(const value of ['red','blue','red']){
      theme=value;config.tours!.journeys.theme!.steps=[{goto:'/'},{expect:{selector:'#theme',text:`.theme{color:${theme}}`}},{shot:{name:'theme',route:'/',fullPage:false,focus:[]}}];
      const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved',resources:{store,scope:'head'}});assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));
    }
    assert.equal(assets,2);assert.equal(store.manifest().length,2);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('fractional text layout produces identical pixels in fresh browser contexts',async()=>{
  const {cwd,head,base}=await project();
  const paragraph='Your settings are available in your personal account. Choose a different account, or ask an administrator to update your access.';
  const server=createServer((_request,response)=>{
    response.setHeader('content-type','text/html');
    response.end(`<style>*{box-sizing:border-box;margin:0}body{display:grid;place-items:center;min-height:100vh;font:16px/1.5 system-ui;-webkit-font-smoothing:antialiased}.panel{display:grid;align-content:center;justify-items:center;width:512px;gap:8px;padding:32px 24px;border:1px solid #ddd}.icon{width:56px;height:56px;margin-bottom:8px}h1{font-size:16px;font-weight:600}p{max-width:42ch;margin-bottom:8px;color:#556070;font-size:14px}.actions{height:40px;margin-top:8px}</style><div class="panel"><span class="icon"></span><h1>Account settings</h1><p>${paragraph}</p><div class="actions">Choose account</div></div>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture address');const url=`http://127.0.0.1:${address.port}`,original=settings(head,base,url);
  const config=parseConfig({...original,tours:{...original.tours,journeys:{paragraph:{account:'visitor',record:false,viewports:[{name:'desktop',width:1440,height:900,scale:2}],steps:[{goto:'/'},{expect:{selector:'p',text:paragraph}},{shot:{name:'text',route:'/',fullPage:false,focus:[]}}]}}}});
  let reference:string|undefined;
  try{
    for(let index=0;index<8;index++){
      const result=await capture({cwd,config,environment:'head',target:'head',all:true,mode:'saved'});assert.equal(result.report.status,'passed',JSON.stringify(result.report.errors));
      const shot=result.report.results[0]!.steps.find(step=>step.action==='shot')!;const image=path.join(result.directory,'paragraph','desktop',shot.file!);
      if(reference)assert.equal((await comparePixels(reference,image)).pixels,0);else reference=image;
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('browser source builds ignore minimal DOM declarations from a host project',async()=>{
  const types=await mkdtemp(path.join(tmpdir(),'pagebeam-host-types-'));
  await mkdir(path.join(types,'host'));
  await writeFile(path.join(types,'host/index.d.ts'),'interface Element {}\ninterface HTMLElement extends Element {}\ninterface SVGElement extends Element {}\n');
  const require=createRequire(import.meta.url),compiler=require.resolve('typescript/bin/tsc'),nodeTypes=path.dirname(path.dirname(require.resolve('@types/node/package.json')));
  await exec(process.execPath,[compiler,'--project',path.resolve(import.meta.dirname,'../tsconfig.json'),'--typeRoots',`${types},${nodeTypes}`,'--types','node,host','--noEmit','--composite','false','--incremental','false']);
});


test('the review deadline writes an incomplete outcome when a judge never responds',{timeout:5000},async(t)=>{
  const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
  const {cwd,head,base}=await project();
  const config=settings(head,base);config.capture!.discovery!.reviewTimeoutMs=100;
  let failure:ReviewFailure|undefined;
  try{await reviewCaptures({cwd,config,environment:'head',target:'head',base,judge:async()=>new Promise<string>(()=>{})});}
  catch(error){assert.ok(error instanceof ReviewFailure);failure=error;}
  assert.ok(failure);
  const outcome=JSON.parse(await readFile(failure.evidence.manifest,'utf8'));
  assert.equal(outcome.status,'incomplete');
  assert.equal(outcome.head.revision,head);
  assert.match(JSON.stringify(outcome),/timeout|aborted/i);
});
