import type { AiProviderRequest,AiProviderResult } from "./provider-contract";
import "server-only";
import { callResponses } from "./provider";
import { priceUsage, type Pricing } from "./pricing";
import type { AiOperation } from "./operations";

/** Adapters own wire format, exact input counting and provider usage normalization.
 * The gate owns permission/reservation/reconciliation. Adding a provider never adds a new gate.
 * `beforeContact` must run synchronously immediately before EVERY provider request (input count and generation alike):
 * the gate releases a dispatched reservation at zero cost only while it has never run. `beforeGenerate` must resolve
 * immediately before the paid generation request; it is where SQL records the generation commit. */
export interface AiProviderAdapter {
 execute(input:AiProviderRequest,transport:typeof fetch|undefined,permit:object,operation:AiOperation,beforeGenerate:()=>Promise<void>,beforeContact:()=>void):Promise<AiProviderResult>;
 accountUsage(raw:unknown,pricing:Pricing):ReturnType<typeof priceUsage>;
}
const providers:Readonly<Record<string,AiProviderAdapter>>=Object.freeze({
 openai:Object.freeze({execute:callResponses,accountUsage:priceUsage}),
});
export function providerFor(id:string):AiProviderAdapter {
 if(!Object.hasOwn(providers,id))throw new Error("Unknown AI provider");
 return providers[id];
}
