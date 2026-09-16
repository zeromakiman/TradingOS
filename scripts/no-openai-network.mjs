// Optional audit preload: node --import ./scripts/no-openai-network.mjs ...
import {writeFileSync} from 'node:fs';
process.env.AI_ENABLED='false';process.env.OPENAI_API_KEY='';
const original=globalThis.fetch,report={started_at:new Date().toISOString(),openai_requests_attempted:0,blocked:true};
const save=()=>writeFileSync('.local/audit-network.json',JSON.stringify(report,null,2)+'\n');save();
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.hostname==='openai.com'||url.hostname.endsWith('.openai.com')){report.openai_requests_attempted++;save();throw new Error('OpenAI network access is disabled for this audit');}return original(input,init);};
