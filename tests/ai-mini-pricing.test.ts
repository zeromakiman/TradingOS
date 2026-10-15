import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('server-only',()=>({}));
import {MINI_PRICING,AI_PRICING,operationPricing,reservationMicros,priceUsage,acceptsResponseModel} from '@/ai/pricing';
import {operationFor} from '@/ai/operations';
import {aiSystemAvailability} from '@/lib/ai-budget';
vi.mock('@/lib/supabase/server',()=>({requireUser:vi.fn()}));
vi.mock('@/lib/supabase/admin',()=>({trustedServer:vi.fn()}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('reviewed Mini profile and registry',()=>{
 it('uses the exact dedicated operation envelope and no tools',()=>{expect(operationFor('REVIEW_TRADE')).toMatchObject({provider:'openai',model:'gpt-5.4-mini',reasoningEffort:'medium',maxInputTokens:24000,maxOutputTokens:6000,maxImages:4,tools:[],pricingProfile:MINI_PRICING.version,version:'REVIEW_TRADE_MINI_V1',contract:'REVIEW_TRADE_V1'});});
 it('reserves exactly 59400 micro-EUR, including conversion and margin',()=>{expect(reservationMicros(MINI_PRICING,operationFor('REVIEW_TRADE'))).toBe(59400);expect(priceUsage({input_tokens:24000,output_tokens:6000},MINI_PRICING).chargedMicros).toBe(54000);});
 it('prices cached input without inventing a cache-write premium or double-counting reasoning',()=>{expect(priceUsage({input_tokens:1000,input_tokens_details:{cached_tokens:200},output_tokens:100,output_tokens_details:{reasoning_tokens:80}},MINI_PRICING)).toMatchObject({chargedMicros:1278,reasoningTokens:80,cachedTokens:200});});
 it.each(['gpt-5.4-mini','gpt-5.4-mini-2026-03-17'])('recognizes only explicitly reviewed model identity %s',model=>expect(acceptsResponseModel(MINI_PRICING,model)).toBe(true));
 it.each([null,'gpt-5.4-mini-unknown','gpt-6-astra','gpt-5.4'])('rejects unreviewed identity %s',model=>expect(acceptsResponseModel(MINI_PRICING,model)).toBe(false));
 it('does not broaden Astra or change legacy setup operations',()=>{expect(acceptsResponseModel(AI_PRICING,'gpt-6-astra-unknown')).toBe(false);for(const id of ['SETUP_ANALYSIS','SETUP_CHALLENGE','SETUP_RECONCILE'])expect(operationFor(id).pricingProfile).toBe(AI_PRICING.version);});
 it('fails closed on expired or mismatched prices and unknown operations',()=>{expect(()=>operationPricing(operationFor('REVIEW_TRADE'),new Date(MINI_PRICING.validUntil))).toThrow(/pricing/);expect(()=>operationPricing({...operationFor('REVIEW_TRADE'),model:'gpt-6-astra'})).toThrow();expect(()=>operationFor('UNKNOWN')).toThrow();});
 it('Mini eligibility does not depend on an expired unrelated Astra profile',()=>{vi.stubEnv('AI_ENABLED','true');vi.stubEnv('OPENAI_API_KEY','mock-only');vi.stubEnv('SUPABASE_SECRET_KEY','sb_secret_mock-only');vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-01T12:00Z'));expect(aiSystemAvailability('REVIEW_TRADE').status).toBe('ENABLED');expect(aiSystemAvailability('SETUP_ANALYSIS').status).toBe('CONFIGURATION_ERROR');expect(aiSystemAvailability().status).toBe('ENABLED');});
 it('global OFF and absent provider credentials still deny Mini',()=>{vi.stubEnv('AI_ENABLED','false');expect(aiSystemAvailability('REVIEW_TRADE').status).toBe('DISABLED');vi.stubEnv('AI_ENABLED','true');vi.stubEnv('OPENAI_API_KEY','');expect(aiSystemAvailability('REVIEW_TRADE').status).toBe('CONFIGURATION_ERROR');});
});

describe('five Mini V1 operation migrations',()=>{
 it.each([["CHALLENGE_BIAS","CHALLENGE_BIAS",16000,4000,3,39600],["ANALYZE_SETUP","ANALYZE_SETUP",16000,5000,3,45540],["WEEKLY_REVIEW","WEEKLY_REVIEW",24000,6000,0,59400],["RECENT_TRADES_ANALYSIS","RECENT_TRADES",32000,6000,0,67320],["MONTHLY_REVIEW","MONTHLY_REVIEW",32000,6000,0,67320]])('preserves the bounded contract and computes the %s reservation',(id,version,input,output,images,hold)=>{const op=operationFor(String(id));expect(op).toMatchObject({provider:'openai',model:'gpt-5.4-mini',pricingProfile:MINI_PRICING.version,version:String(version)+'_MINI_V1',contract:String(version)+'_V1',reasoningEffort:'medium',maxInputTokens:input,maxOutputTokens:output,maxImages:images,tools:[],safetyMultiplier:'1.10'});expect(reservationMicros(operationPricing(op,new Date('2026-10-13T12:00Z')),op)).toBe(hold);expect(reservationMicros(undefined,op)).toBe(hold);});
 it('blocks unknown implicit pricing instead of using another model profile',()=>expect(()=>reservationMicros(undefined,{...operationFor('CHALLENGE_BIAS'),pricingProfile:'unknown'})).toThrow(/pricing/));
});
