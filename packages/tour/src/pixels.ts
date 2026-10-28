import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';

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
  const pixels=pixelmatch(padded(a),padded(b),data,width,height,{threshold:0.1,includeAA:false,...(ignoreMask?.length===width*height?{ignoreMask}:{})});
  if(output)await writeFile(output,PNG.sync.write({width,height,data}));
  return {width,height,pixels,percent:100*pixels/(width*height),dimensionsChanged:a.width!==b.width||a.height!==b.height};
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
