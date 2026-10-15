import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({review:vi.fn(),refresh:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:m.refresh}));vi.mock('next/navigation',()=>({unstable_rethrow:()=>{}}));vi.mock('@/lib/trade-review',()=>({reviewTrade:m.review}));
import {requestTradeReview} from '@/app/trade-review-actions';
import {ids} from './fixtures/trade-review';
const form=()=>{const f=new FormData();f.set('planId',ids.plan);f.set('requestKey',ids.review);return f;};
beforeEach(()=>{vi.clearAllMocks();m.review.mockResolvedValue({status:'COMPLETED',message:'Saved'});});
describe('explicit review Server Action',()=>{
 it('forwards only ids and selected evidence, ignoring client cost/account/provider inputs',async()=>{const f=form();f.set('cost','0');f.set('accountId','foreign');f.set('model','unreviewed');f.append('evidence',ids.image);expect(await requestTradeReview({},f)).toEqual({success:'Saved'});expect(m.review).toHaveBeenCalledWith(ids.plan,ids.review,[ids.image]);expect(m.refresh.mock.calls).toEqual([[`/journal/${ids.plan}`],['/settings']]);});
 it.each(['COMPLETED','FAILED','RECORDED'])('%s rotates only terminal request keys through success state',async status=>{m.review.mockResolvedValue({status,message:'Recorded'});expect(await requestTradeReview({},form())).toEqual({success:'Recorded'});});
 it('blocked attempts return useful error state without success',async()=>{m.review.mockResolvedValue({status:'BUDGET_REACHED',message:'Insufficient budget'});expect(await requestTradeReview({},form())).toEqual({error:'Insufficient budget'});});
 it('over-limit evidence is rejected before service dispatch',async()=>{const f=form();for(let i=0;i<5;i++)f.append('evidence',ids.image);expect(await requestTradeReview({},f)).toHaveProperty('error');expect(m.review).not.toHaveBeenCalled();});
 it('malformed request ids and foreign ownership errors do not leak internal details',async()=>{const f=form();f.set('requestKey','bad');expect(await requestTradeReview({},f)).toHaveProperty('error');expect(m.review).not.toHaveBeenCalled();m.review.mockRejectedValue(new Error('private database detail'));const result=await requestTradeReview({},form());expect(result.error).not.toContain('private database detail');expect(result.error).toContain('ownership');});
});
