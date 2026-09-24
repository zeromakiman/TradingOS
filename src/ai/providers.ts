import type { AiProviderRequest,AiProviderResult } from "./provider-contract";
import "server-only";
import { callResponses } from "./provider";
import { priceUsage, type Pricing } from "./pricing";
import type { AiOperation } from "./operations";

/** Adapters own wire format, exact input counting and provider usage normalization.
 * The gate owns permission/reservation/reconciliation. Adding a provider never adds a new gate. */
export interface AiProviderAdapter {
 execute(input:AiProviderRequest,transport:typeof fetch|undefined,permit:object,operation:AiOperation,beforeGenerate:()=>Promise<void>):Promise<AiProviderResult>;
 accountUsage(raw:unknown,pricing:Pricing):ReturnType<typeof priceUsage>;
}
const providers:Readonly<Record<string,AiProviderAdapter>>=Object.freeze({
 openai:Object.freeze({execute:callResponses,accountUsage:priceUsage}),
});
export function providerFor(id:string):AiProviderAdapter {
 if(!Object.hasOwn(providers,id))throw new Error("Unknown AI provider");
 return providers[id];
}
