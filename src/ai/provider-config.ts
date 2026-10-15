/** Server environment names only, never values; provider selection comes from the operation registry. */
const providerKeys:Readonly<Record<string,string>>=Object.freeze({openai:"OPENAI_API_KEY"});
export function assertOperationExecutionAllowed(provider:string,apiKey?:string) {
 if(process.env.AI_ENABLED!=="true")throw new Error("AI analysis is currently disabled");
 const configured=providerKey(provider);
 if(apiKey!==undefined&&apiKey!==configured)throw new Error("AI API key must match server configuration");
}
export function providerKey(provider:string,env:Record<string,string|undefined>=process.env):string {
 if(!Object.hasOwn(providerKeys,provider))throw new Error("Unknown AI provider");
 const key=env[providerKeys[provider]]?.trim();
 if(!key)throw new Error("AI is enabled but its API key is missing. Other application features remain available.");
 return key;
}
