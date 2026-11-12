import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import path from 'node:path';
import type { CaptureOutcome } from './outcome.js';

interface Image {width:number;height:number;data:Buffer}
const {PNG}=createRequire(import.meta.url)('pngjs') as {PNG:{sync:{read(buffer:Buffer):Image;write(image:Image):Buffer}}};
const read=async(file:string):Promise<Image>=>PNG.sync.read(await readFile(file));
export async function comparePixels(first:string,second:string,output?:string,ignoreMask?:Uint8Array) {
  const a=await read(first),b=await read(second);
  const width=Math.max(a.width,b.width),height=Math.max(a.height,b.height);
  const padded=(image:Image):Buffer=>{
    const data=Buffer.alloc(width*height*4,255);
    for(let row=0;row<image.height;row++)image.data.copy(data,row*width*4,row*image.width*4,(row+1)*image.width*4);
    return data;
  };
  const data=Buffer.alloc(width*height*4);
  const firstData=padded(a),secondData=padded(b);
  const options={threshold:0.1,includeAA:false,...(ignoreMask?.length===width*height?{ignoreMask}:{})};
  const pixels=pixelmatch(firstData,secondData,data,width,height,{...options,diffMask:true});
  let region:[number,number,number,number]|null=null;
  if(pixels){
    let left=width,top=height,right=0,bottom=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]){
      left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
    }
    region=[left/width,top/height,(right-left+1)/width,(bottom-top+1)/height].map(value=>Number(value.toFixed(4))) as [number,number,number,number];
  }
  if(output)pixelmatch(firstData,secondData,data,width,height,options);
  if(output)await writeFile(output,PNG.sync.write({width,height,data}));
  return {width,height,pixels,region,percent:100*pixels/(width*height),dimensionsChanged:a.width!==b.width||a.height!==b.height};
}
export async function learnVolatility(reference:string,calibration:string[],holdout?:string) {
  const first=await read(reference),mask=new Uint8Array(first.width*first.height);
  for(const file of calibration){
    const next=await read(file);
    if(next.width!==first.width||next.height!==first.height)throw new Error('Calibration screenshot dimensions changed');
    const diff=Buffer.alloc(first.data.length);
    pixelmatch(first.data,next.data,diff,first.width,first.height,{threshold:0.1,includeAA:false,diffMask:true});
    for(let index=0;index<mask.length;index++)if(diff[index*4+3])mask[index]=1;
  }
  const volatilePixels=mask.reduce((sum,value)=>sum+value,0);
  const withinBudget=volatilePixels<=Math.min(1024,mask.length*0.001);
  const validation=holdout?await comparePixels(reference,holdout,undefined,mask):undefined;
  return {mask,volatilePixels,valid:calibration.length>0&&Boolean(holdout)&&withinBudget&&!validation?.pixels&&!validation?.dimensionsChanged,holdoutPixels:validation?.pixels??0};
}

export async function compareOutcomePixels(directory:string,outcome:CaptureOutcome,diffImages:boolean,masks:ReadonlyMap<string,Uint8Array>=new Map()):Promise<void> {
  outcome.diffImages=diffImages;
  for(const [index,shot] of outcome.captures.entries()){
    if(!shot.head||!shot.base)continue;
    const base=path.join(directory,shot.base),head=path.join(directory,shot.head),mask=masks.get(shot.journey);
    const difference=await comparePixels(base,head,undefined,mask);
    shot.pixels=difference.pixels;shot.percent=difference.percent;shot.region=difference.region;
    if(diffImages&&difference.pixels){
      const diff=`capture-${index}-diff.png`;
      await comparePixels(base,head,path.join(directory,diff),mask);
      shot.diff=diff;outcome.evidence.push({id:diff,file:diff,mediaType:'image/png'});
    }
  }
}
