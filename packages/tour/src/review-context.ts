import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { componentMarkup, history, impactSources, screensOf } from '@pagebeam/app';
import { withheld } from '@pagebeam/model';
import type { PagebeamConfig } from '@pagebeam/core';
import { changedFiles } from './selection.js';
import { planCaptures } from './plan.js';

export async function reviewContext(request: {cwd:string; config:PagebeamConfig; base?:string | undefined; changed?:string[] | undefined}) {
  const {cwd,config} = request;
  if (!config.tours) throw new Error('Review needs application targets and account setup');
  const changed = request.changed ?? (request.base ? await changedFiles(cwd,request.base) : undefined);
  if (!changed) throw new Error('Review needs --base or --changed-files');
  const plan = await planCaptures({...request,changed});
  const scope=path.relative(cwd,path.resolve(cwd,config.capture?.impact?.root??'.')).split(path.sep).join('/')||'.';
  const ignored = (plan.coverage?.ignored??[]).map(file=>path.posix.normalize(path.posix.join(scope==='.'?'':scope,file)));
  const sources = await impactSources(cwd);
  const graph=screensOf(sources,[],{root:scope});
  const inside=(file:string)=>scope==='.'||file.startsWith(scope+'/');
  const entries=[...(graph.applications??new Map()).entries()].filter(([application])=>inside(application)||application===scope).flatMap(([,routes])=>[...routes]);
  const dependencies=new Set(entries.flatMap(([,files])=>[...files]));
  const otherApplications=[...(graph.applications??new Map()).keys()].filter(application=>application!=='.'&&!inside(application)&&application!==scope);
  const files = changed.filter(file => !ignored.includes(file) && (inside(file)||dependencies.has(file)||!otherApplications.some(application=>file.startsWith(application+'/'))));
  ignored.push(...changed.filter(file=>!files.includes(file)&&!ignored.includes(file)));
  const routes=entries.map(([route])=>route);
  const views:{path:string;head:string;base:string}[]=[];
  if(config.model?.sendSource)for(const file of [...files].sort((a,b)=>Number(inside(b))-Number(inside(a))||a.localeCompare(b))){
    const at=path.resolve(cwd,file);if(!at.startsWith(path.resolve(cwd)+path.sep))continue;
    const head=componentMarkup(file,await readFile(at,'utf8').catch(()=>''));
    const base=request.base?componentMarkup(file,await promisify(execFile)('git',['-C',cwd,'show',`${request.base}:${file}`],{maxBuffer:4<<20}).then(result=>result.stdout,()=>'')):'';
    if(head||base)views.push({path:file,head,base});
  }
  let markupBudget=48000;
  const markup:{head:{path:string;text:string}[];base:{path:string;text:string}[]}={head:[],base:[]};
  for(const view of views)for(const side of ['head','base'] as const){
    if(!markupBudget)break;const text=view[side];if(!text)continue;const limit=Math.min(12000,markupBudget);
    const excerpt=text.length>limit?text.slice(0,limit/2)+'\n[Markup excerpt shortened]\n'+text.slice(-limit/2):text;
    markup[side].push({path:view.path,text:excerpt});markupBudget-=Math.min(excerpt.length,markupBudget);
  }
  markup.head=withheld(markup.head).sending;markup.base=withheld(markup.base).sending;
  const responsiveFiles:string[]=[];
  for(const file of files.filter(file=>/\.(?:vue|svelte|html|css|scss|sass|less)$/.test(file))){
    const at=path.resolve(cwd,file);if(!at.startsWith(path.resolve(cwd)+path.sep))continue;
    const after=await readFile(at,'utf8').catch(()=> '');
    const before=request.base?await promisify(execFile)('git',['-C',cwd,'show',`${request.base}:${file}`],{maxBuffer:4<<20}).then(result=>result.stdout,()=> ''):'';
    const styles=(text:string)=>/\.(?:css|scss|sass|less)$/.test(file)?text:[...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>match[1]).join('\n');
    if(after!==before&&/@(?:media|container)[^{]*(?:width|orientation)|flex-wrap\s*:\s*wrap|repeat\(\s*auto-(?:fit|fill)/i.test(styles(before)+'\n'+styles(after)))responsiveFiles.push(file);
  }
  const sending: {path:string;text:string}[] = [];
  let remaining = 120_000;
  if (config.model?.sendSource) {
    const priority=(file:string)=>/\.(vue|tsx|jsx|html)$/.test(file)?0:/\.[cm]?[jt]s$/.test(file)?1:2;
    const ordered=[...files].sort((a,b)=>priority(a)-priority(b)||a.localeCompare(b));
    const reserve=Math.min(1000,Math.floor(remaining/Math.max(1,ordered.length)));
    for (const [index,file] of ordered.entries()) {
      if (!remaining) break;
      let text: string;
      if (request.base) {
        text = (await promisify(execFile)('git',['-C',cwd,'diff','--no-ext-diff','--unified=3',`${request.base}...HEAD`,'--',file],{maxBuffer:4<<20})).stdout;
      } else {
        const at = path.resolve(cwd,file);
        if (!at.startsWith(path.resolve(cwd)+path.sep)) continue;
        text = await readFile(at,'utf8').catch(() => '');
      }
      const length = Math.min(12_000,Math.max(0,remaining-reserve*(ordered.length-index-1)));
      const excerpt = text.length > length ? text.slice(0,length/2)+'\n[Source excerpt shortened]\n'+text.slice(-length/2) : text;
      sending.push({path:file,text:excerpt}); remaining -= Math.min(excerpt.length,remaining);
    }
  }
  const filtered = withheld(sending);
  return {
    revision:await history.head(cwd), base:request.base ?? null,
    applicationRoot:scope, changed:files, ignored, staticCoverage:plan.coverage, routes,
    surfaces:entries.map(([route,files])=>({route,files:[...files]})),
    accounts:Object.fromEntries(Object.entries(config.tours.accounts).map(([name,account]) => [name,{purpose:account.purpose}])),
    source:filtered.sending, withheld:filtered.held, responsiveFiles, markup,
    sourceSharing:config.model?.sendSource ?? false,
  };
}


export async function navigationSources(cwd:string,files:string[],base?:string|null){
  const excerpts:{path:string;text:string}[]=[];
  let remaining=48000;
  for(const file of files){
    if(!remaining)break;
    const at=path.resolve(cwd,file);
    if(!at.startsWith(path.resolve(cwd)+path.sep))continue;
    let text=base
      ?await promisify(execFile)('git',['-C',cwd,'show',`${base}:${file}`],{maxBuffer:4<<20}).then(result=>result.stdout,()=> '')
      :await readFile(at,'utf8').catch(()=> '');
    if(file.endsWith('.vue'))text=text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
    const limit=Math.min(24000,remaining);
    if(text.length>limit)text=text.slice(0,limit/2)+'\n[Source excerpt shortened]\n'+text.slice(-limit/2);
    excerpts.push({path:file,text});remaining-=Math.min(text.length,remaining);
  }
  return withheld(excerpts).sending;
}
