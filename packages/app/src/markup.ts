import {parse as vue} from '@vue/compiler-sfc';
import {parse} from '@babel/parser';
import {html} from './html.js';
import {walk} from './resolution.js';

export function componentMarkup(file:string,text:string):string{
  if(file.endsWith('.vue')){
    try{return vue(text,{filename:file}).descriptor.template?.content??'';}catch{return '';}
  }
  if(html.handles(file))return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  if(!/\.[cm]?[jt]sx?$/.test(file))return '';
  try{
    const tree=parse(text,{sourceType:'unambiguous',plugins:['typescript','jsx','decorators-legacy']});
    const ranges:{start:number;end:number}[]=[];
    walk(tree,node=>{if(['JSXElement','JSXFragment'].includes(node.type)&&typeof node.start==='number'&&typeof node.end==='number')ranges.push({start:node.start,end:node.end});});
    const parts:string[]=[];let end=-1;
    for(const range of ranges.sort((a,b)=>a.start-b.start||b.end-a.end))if(range.start>=end){parts.push(text.slice(range.start,range.end));end=range.end;}
    return parts.join('\n');
  }catch{return '';}
}
