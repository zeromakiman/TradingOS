// Automated tests cannot accidentally use paid OpenAI services, even with shell credentials.
process.env.AI_ENABLED='false';
process.env.OPENAI_API_KEY='';
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.hostname==='openai.com'||url.hostname.endsWith('.openai.com'))throw new Error('Live OpenAI calls are forbidden in automated tests');
 return originalFetch(input,init);
};
