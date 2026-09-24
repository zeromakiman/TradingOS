/** Provider-neutral request/result boundary. Raw usage is normalized by the selected adapter. */
export interface AiProviderRequest {
 apiKey:string;
 config:{model:string;reasoningEffort:string;timeoutMs:number;maxOutputTokens:number;imageDetail:"high";deepEnabled:boolean};
 context:unknown;images:{sourceId:string;role:string;dataUrl:string}[];prior:unknown[];
}
export interface AiProviderResult {output:unknown;responseId:string;model:string;usage:unknown}
