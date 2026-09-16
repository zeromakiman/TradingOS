import { readFileSync, writeFileSync } from 'node:fs';
import { ICT_V1 } from '../src/domain/strategy.ts';
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const rules = quote(JSON.stringify(ICT_V1));
const written = quote(readFileSync(new URL('../docs/PRODUCT_REQUIREMENTS.txt',import.meta.url),'utf8'));
writeFileSync(new URL('../supabase/migrations/0002_baseline.sql',import.meta.url), `-- Generated from the preserved user requirements and ICT_V1. Do not edit historical seeds.
create function public.create_demo_account(p_name text,p_equity text,p_balance text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a_id uuid; day date := private.strategy_day(clock_timestamp());
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.accounts(user_id,name,currency) values(auth.uid(),trim(p_name),'USD') returning id into a_id;
  insert into public.account_observations(user_id,account_id,equity,balance,trading_day)
    values(auth.uid(),a_id,private.positive_money(p_equity),private.positive_money(p_balance),day);
  insert into public.strategy_versions(user_id,account_id,version,rules,written_rules)
    values(auth.uid(),a_id,'ICT V1.0',${rules}::jsonb,${written});
  insert into public.risk_plan_versions(user_id,account_id,version,effective_day,max_risk_percent,max_daily_trades,min_rr,rr_policy,news_policy)
    values(auth.uid(),a_id,'Risk Plan V1.0',day,0.5,2,3,'BLOCK','WARN');
  insert into public.instrument_versions(user_id,account_id,symbol,currency,quantity_unit,tick_size,pip_size,tick_value,quantity_step,minimum_quantity)
    values(auth.uid(),a_id,'EURUSD','USD','lots (100,000 EUR)',0.00001,0.0001,1,0.01,0.01),
          (auth.uid(),a_id,'GBPUSD','USD','lots (100,000 GBP)',0.00001,0.0001,1,0.01,0.01);
  insert into public.configuration_events(user_id,account_id,event_type,payload)
    values(auth.uid(),a_id,'ACCOUNT_INITIALIZED',jsonb_build_object('strategy','ICT V1.0','risk_plan','Risk Plan V1.0','currency','USD','mode','DEMO'));
  return a_id;
end $$;
revoke all on function public.create_demo_account(text,text,text) from public,anon;
grant execute on function public.create_demo_account(text,text,text) to authenticated;
`);
