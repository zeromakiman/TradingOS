import sharp from "sharp";
import { createHash } from "node:crypto";
export const SCREENSHOT_BUCKET="setup-screenshots";
export const MAX_SCREENSHOT_BYTES=4*1024*1024;
export const SCREENSHOT_ROLES=["DAILY","H4","H1","M30","M15","M5","M3","OTHER"] as const;
export async function validateScreenshot(bytes:Buffer,claimedMime:string){
 if(!bytes.length||bytes.length>MAX_SCREENSHOT_BYTES)throw new Error("Images must be between 1 byte and 4 MB");
 const signatures:Record<string,boolean>={"image/png":bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),"image/jpeg":bytes[0]===255&&bytes[1]===216&&bytes[2]===255,"image/webp":bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"};
 if(!signatures[claimedMime])throw new Error("File bytes do not match PNG, JPEG or WEBP type");
 try{
  const decoder=sharp(bytes,{limitInputPixels:40000000,failOn:"warning",animated:true});
  const meta=await decoder.metadata();
  if(!meta.width||!meta.height||(meta.pages??1)>1||meta.width*meta.height>40000000)throw new Error("Unsupported image dimensions or animation");
  // Full decode detects truncated/corrupt payloads; keep original chart pixels and bytes for the audit hash.
  await decoder.stats();
  return {width:meta.width,height:meta.height,byte_size:bytes.length,mime_type:claimedMime,sha256:createHash("sha256").update(bytes).digest("hex")};
 }catch{throw new Error("Image cannot be fully decoded, is animated, or exceeds 40 megapixels");}
}
