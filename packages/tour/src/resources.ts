import {createHash} from 'node:crypto';
import type {Request,Response,Route} from 'playwright-core';

interface Resource {scope:string;url:string;vary:Record<string,string>;headers:Record<string,string>;body:Buffer}
const normalized=(headers:Record<string,string>)=>Object.fromEntries(Object.entries(headers).map(([key,value])=>[key.toLowerCase(),value]));
const credentials=(headers:Record<string,string>)=>Object.keys(headers).some(key=>/authorization|cookie|api.?key|token|secret|password|(?:^|[-_])(?:key|auth|sig|credential)(?:$|[-_])/i.test(key));
function address(request:Request):URL|undefined{
  if(request.method()!=='GET'||request.isNavigationRequest())return;
  const url=new URL(request.url());
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(key=>/token|secret|password|(?:^|[_-])(?:key|sig|sas|auth|credential)(?:$|[_-])|signature|authorization/i.test(key)))return;
  return url;
}

export class PublicResources {
  private entries=new Map<string,Resource[]>();
  private pending=new Set<Promise<void>>();
  private bytes=0;
  constructor(private readonly limit=20<<20,private readonly itemLimit=2<<20){}

  async fulfill(route:Route,scope:string):Promise<boolean>{
    const request=route.request(),url=address(request);if(!url)return false;
    const entries=this.entries.get(scope+'\n'+url.href);if(!entries)return false;
    const headers=normalized(await request.allHeaders());if(credentials(headers)||headers.range)return false;
    const resource=entries.find(entry=>Object.entries(entry.vary).every(([key,value])=>(headers[key]??'')===value));if(!resource)return false;
    await route.fulfill({status:200,headers:resource.headers,body:resource.body});return true;
  }

  capture(response:Response,scope:string,origin:string):void{
    const task=this.read(response,scope,origin).catch(()=>{});this.pending.add(task);
    void task.finally(()=>this.pending.delete(task));
  }

  private async read(response:Response,scope:string,origin:string):Promise<void>{
    const request=response.request(),url=address(request);if(!url||response.status()!==200)return;
    const headers=normalized(await response.allHeaders()),policy=headers['cache-control']??'';
    if(!/\b(?:public|immutable)\b/i.test(policy)||/\b(?:private|no-store|no-cache)\b/i.test(policy)||!/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?[1-9]\d*/i.test(policy)||headers['set-cookie'])return;
    const type=headers['content-type']??'';
    const asset=/^(?:text\/css|(?:application|text)\/(?:javascript|ecmascript)|image\/|font\/|application\/font|application\/wasm)/i.test(type);
    const json=/^application\/json\b/i.test(type)&&url.origin!==origin&&url.pathname.endsWith('.json');
    if(!asset&&!json||Number(headers['content-length']??0)>this.itemLimit||this.bytes>=this.limit)return;
    const input=normalized(await request.allHeaders());if(credentials(input)||input.range)return;
    const keys=(headers.vary??'').toLowerCase().split(',').map(key=>key.trim()).filter(Boolean);if(keys.includes('*'))return;
    if(headers['access-control-allow-origin']&&headers['access-control-allow-origin']!=='*'&&!keys.includes('origin'))keys.push('origin');
    const vary=Object.fromEntries(keys.map(key=>[key,input[key]??''])),key=scope+'\n'+url.href;
    const duplicate=()=>this.entries.get(key)?.some(entry=>JSON.stringify(entry.vary)===JSON.stringify(vary));if(duplicate())return;
    const body=await response.body();if(body.length>this.itemLimit||this.bytes+body.length>this.limit||duplicate())return;
    for(const name of ['content-length','content-encoding','transfer-encoding','connection','keep-alive'])delete headers[name];
    this.entries.set(key,[...(this.entries.get(key)??[]),{scope,url:url.href,vary,headers,body}]);this.bytes+=body.length;
  }

  async flush():Promise<void>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([Promise.all([...this.pending]),new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]);}finally{clearTimeout(timer);}
  }

  manifest(){
    return [...this.entries.values()].flat().map(resource=>({scope:resource.scope,origin:new URL(resource.url).origin,requestSha256:createHash('sha256').update(resource.url).digest('hex'),bytes:resource.body.length,sha256:createHash('sha256').update(resource.body).digest('hex')})).sort((a,b)=>a.scope.localeCompare(b.scope)||a.requestSha256.localeCompare(b.requestSha256));
  }
}
