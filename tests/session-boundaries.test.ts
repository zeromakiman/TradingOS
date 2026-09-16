import {describe,it,expect} from 'vitest';
import {strategyClock} from '@/domain/session';
describe('fixed UTC-5 exact session boundaries',()=>{
  it.each([['05:59','ASIA'],['06:00','JUDAS'],['06:59','JUDAS'],['07:00','ACTIVE_KILL_ZONE'],['16:59','ACTIVE_KILL_ZONE'],['17:00','DEAD_POOL'],['22:59','DEAD_POOL'],['23:00','ASIA']])('%s UTC is %s',(time,session)=>expect(strategyClock(`2026-09-05T${time}:00Z`).session).toBe(session));
  it.each([['2026-01-01T04:59:59.999Z','2025-12-31'],['2026-01-01T05:00:00Z','2026-01-01'],['2024-03-01T04:59:59Z','2024-02-29'],['2026-03-01T04:59:59Z','2026-02-28']])('handles day rollover %s',(time,day)=>expect(strategyClock(time).day).toBe(day));
  it.each(['2026-03-08','2026-11-01'])('does not shift for US daylight savings %s',day=>expect(strategyClock(`${day}T17:00:00Z`).session).toBe('DEAD_POOL'));
  it('treats equivalent explicit offsets identically',()=>expect(strategyClock('2026-09-05T19:00:00+02:00')).toEqual(strategyClock('2026-09-05T12:00:00-05:00')));
});
