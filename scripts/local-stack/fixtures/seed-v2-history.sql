-- Session-local (pg_temp) helpers for scripts/local-stack/seed-v2.mjs. LOCAL stack, SYNTHETIC data only.
--
-- The V2 RPCs stamp their records with clock_timestamp(), so they cannot write history: a plan locked 40 days ago,
-- the fill recorded two minutes after it, a note written while the position was open. Each helper below performs the
-- inserts of the Trading OS RPC named in its comment, with that RPC's validation, at an explicit past time p_at.
--   * Insert-only. Nothing is updated or deleted, no trigger or constraint is disabled; every table check, foreign
--     key and immutability trigger applies exactly as it does for the RPCs.
--   * The Risk Engine decides: drafts and locks are evaluated by private.risk_report_v12 with private.daily_usage at
--     p_at, against the observation and risk-plan version that existed at p_at. A lock whose report is not APPROVED
--     raises, so no plan can exist that the engine would have blocked (Dead Pool, slots, caps, stale equity, ...).
--   * Stored phase and state at creation come from private.trade_phase / private.trade_lifecycle, exactly as in
--     add_journal_entry and register_trade_evidence. The caller emits events in chronological order, so these
--     functions (and the engine's daily usage) see exactly the records that existed at that moment.
--   * pg_temp functions disappear with the psql session: the schema is never changed.

create function pg_temp.fail(p_message text) returns void language plpgsql as $$
begin
  raise exception 'SEED_V2: %', p_message;
end $$;

-- Latest observation recorded at or before p_at (assess_plan: latest by recorded_at at that time).
create function pg_temp.observation_at(p_account uuid, p_at timestamptz) returns public.account_observations
language sql stable as $$
  select o.* from public.account_observations o
   where o.account_id = p_account and o.recorded_at <= p_at
   order by o.recorded_at desc, o.id desc limit 1
$$;

-- private.active_risk_plan as it answered at p_at: versions in effect that day and already created by then.
create function pg_temp.risk_plan_at(p_account uuid, p_at timestamptz) returns public.risk_plan_versions
language sql stable as $$
  select r.* from public.risk_plan_versions r
   where r.account_id = p_account and r.effective_day <= private.strategy_day(p_at) and r.created_at <= p_at
   order by r.created_at desc, r.id desc limit 1
$$;

-- The evaluation half of private.assess_plan (0016) at p_at: context, daily usage, duplicate check, report 1.2.
create function pg_temp.evaluate(p_account uuid, p_proposal jsonb, p_at timestamptz) returns jsonb
language plpgsql as $$
declare
  a public.accounts; o public.account_observations; r public.risk_plan_versions; i public.instrument_versions;
  s public.strategy_versions; v_usage jsonb; v_duplicate boolean := false; v_report jsonb;
begin
  select * into a from public.accounts where id = p_account;
  o := pg_temp.observation_at(p_account, p_at);
  r := pg_temp.risk_plan_at(p_account, p_at);
  select * into s from public.strategy_versions where account_id = p_account and version = 'ICT V1.0';
  select * into i from public.instrument_versions where account_id = p_account and id = (p_proposal ->> 'instrumentId')::uuid;
  if a.id is null or r.id is null or o.id is null or s.id is null or i.id is null then
    perform pg_temp.fail(format('account configuration is incomplete at %s', p_at));
  end if;
  v_usage := private.daily_usage(p_account, p_at, null);
  if p_proposal ->> 'entry' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' and p_proposal ->> 'stop' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$'
     and p_proposal ->> 'target' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then
    select exists (select 1 from public.trade_plans p
                    where p.account_id = p_account and p.trading_day = private.strategy_day(p_at)
                      and (p.proposal ->> 'instrumentId')::uuid = i.id and p.proposal ->> 'direction' = p_proposal ->> 'direction'
                      and p.proposal ->> 'model' = p_proposal ->> 'model'
                      and (p.proposal ->> 'entry')::numeric = (p_proposal ->> 'entry')::numeric
                      and (p.proposal ->> 'stop')::numeric = (p_proposal ->> 'stop')::numeric
                      and (p.proposal ->> 'target')::numeric = (p_proposal ->> 'target')::numeric)
      into v_duplicate;
  end if;
  v_report := private.risk_report_v12(p_proposal, a, o, r, i, s, p_at, v_usage, v_duplicate);
  return jsonb_build_object('report', v_report, 'observationId', o.id, 'riskPlanId', r.id, 'instrumentId', i.id, 'strategyId', s.id);
end $$;

-- Asserts the engine decision a dataset step was designed for; the message lists the issue codes.
create function pg_temp.expect_decision(p_report jsonb, p_expect text, p_what text) returns void
language plpgsql as $$
begin
  if p_expect is not null and p_report ->> 'decision' is distinct from p_expect then
    perform pg_temp.fail(format('%s: expected %s, the engine decided %s (%s)', p_what, p_expect, p_report ->> 'decision',
      (select string_agg((x ->> 'code') || '/' || (x ->> 'severity'), ', ') from jsonb_array_elements(p_report -> 'issues') x)));
  end if;
end $$;

-- public.create_trading_account at p_at. p_instruments names the ids of the USD default instruments {EURUSD, GBPUSD}.
create function pg_temp.seed_account(p_user uuid, p_account uuid, p_request_key uuid, p_input jsonb, p_instruments jsonb, p_at timestamptz)
returns void language plpgsql as $$
declare
  v_name text; v_currency text; v_type text; v_platform text; v_broker text;
  v_balance numeric; v_equity numeric; v_starting numeric; v_day date := private.strategy_day(p_at);
begin
  perform private.require_object(p_input, array['name','currency','accountType','platform','broker','startingBalance','balance','equity'], 'account');
  v_name := btrim(private.json_text(p_input, 'name'));
  v_currency := private.json_text(p_input, 'currency');
  v_type := private.json_text(p_input, 'accountType');
  v_platform := private.json_text(p_input, 'platform');
  v_broker := nullif(btrim(private.json_text(p_input, 'broker')), '');
  if v_name is null or length(v_name) not between 1 and 100 then perform pg_temp.fail('account name'); end if;
  if not (v_currency = any (private.supported_currencies())) then perform pg_temp.fail('account currency'); end if;
  if v_type not in ('DEMO','EVALUATION','FUNDED','PERSONAL','OTHER') then perform pg_temp.fail('account type'); end if;
  if v_platform not in ('MANUAL','CTRADER','MT5','MT4','TRADINGVIEW','OTHER') then perform pg_temp.fail('account platform'); end if;
  v_balance := private.money_input(private.json_text(p_input, 'balance'), 'balance');
  v_equity := private.money_input(private.json_text(p_input, 'equity'), 'equity');
  v_starting := coalesce(private.money_input(private.json_text(p_input, 'startingBalance'), 'startingBalance'), v_balance);
  insert into public.accounts(id, user_id, name, currency, created_at) values (p_account, p_user, v_name, v_currency, p_at);
  insert into public.account_observations(user_id, account_id, equity, balance, trading_day, recorded_at)
    values (p_user, p_account, v_equity, v_balance, v_day, p_at);
  insert into public.strategy_versions(user_id, account_id, version, rules, written_rules, created_at)
    select p_user, p_account, t.version, t.rules, t.written_rules, p_at from private.strategy_templates t where t.version = 'ICT V1.0';
  insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
      max_daily_trades, min_rr, rr_policy, news_policy, created_at)
    values (p_user, p_account, 'Risk Plan V1.0', v_day, 0.5, 0.5, 2, 3, 'BLOCK', 'WARN', p_at);
  if v_currency = 'USD' then
    insert into public.instrument_versions(id, user_id, account_id, symbol, currency, quantity_unit, tick_size, pip_size, tick_value,
        quantity_step, minimum_quantity, created_at)
      values ((p_instruments ->> 'EURUSD')::uuid, p_user, p_account, 'EURUSD', 'USD', 'lots (100,000 EUR)', 0.00001, 0.0001, 1, 0.01, 0.01, p_at),
             ((p_instruments ->> 'GBPUSD')::uuid, p_user, p_account, 'GBPUSD', 'USD', 'lots (100,000 GBP)', 0.00001, 0.0001, 1, 0.01, 0.01, p_at);
  end if;
  insert into public.configuration_events(user_id, account_id, event_type, payload, recorded_at)
    values (p_user, p_account, 'ACCOUNT_INITIALIZED', jsonb_build_object('strategy', 'ICT V1.0', 'risk_plan', 'Risk Plan V1.0',
      'currency', v_currency, 'account_type', v_type, 'platform', v_platform), p_at);
  insert into public.account_profiles(user_id, account_id, display_name, broker, platform, account_type, starting_balance, status, source, recorded_at)
    values (p_user, p_account, v_name, v_broker, v_platform, v_type, v_starting, 'ACTIVE', 'USER', p_at);
  insert into public.bootstrap_requests(user_id, idempotency_key, account_id, input, recorded_at)
    values (p_user, p_request_key, p_account, jsonb_build_object('kind', 'TRADING_ACCOUNT', 'name', v_name, 'currency', v_currency,
      'accountType', v_type, 'platform', v_platform, 'broker', v_broker, 'startingBalance', v_starting, 'balance', v_balance,
      'equity', v_equity), p_at);
end $$;

-- public.create_instrument_version at p_at (contract valued in the account currency, source USER_DEFINED).
create function pg_temp.seed_instrument(p_account uuid, p_id uuid, p_input jsonb, p_at timestamptz) returns void
language plpgsql as $$
declare a public.accounts; v_symbol text; v_unit text; v_tick numeric; v_pip numeric; v_value numeric; v_step numeric; v_minimum numeric;
begin
  select * into a from public.accounts where id = p_account;
  perform private.require_object(p_input, array['symbol','quantityUnit','tickSize','pipSize','tickValue','quantityStep','minimumQuantity'], 'instrument');
  v_symbol := private.json_text(p_input, 'symbol');
  if v_symbol is null or v_symbol !~ '^[A-Z0-9][A-Z0-9._/-]{0,19}$' then perform pg_temp.fail('instrument symbol'); end if;
  v_unit := btrim(private.json_text(p_input, 'quantityUnit'));
  if v_unit is null or length(v_unit) not between 1 and 60 then perform pg_temp.fail('instrument unit'); end if;
  v_tick := private.decimal_input(private.json_text(p_input, 'tickSize'), 'tickSize');
  v_pip := private.decimal_input(private.json_text(p_input, 'pipSize'), 'pipSize');
  v_value := private.decimal_input(private.json_text(p_input, 'tickValue'), 'tickValue');
  v_step := private.decimal_input(private.json_text(p_input, 'quantityStep'), 'quantityStep');
  v_minimum := private.decimal_input(private.json_text(p_input, 'minimumQuantity'), 'minimumQuantity');
  if v_tick is null or v_value is null or v_step is null or v_minimum is null then perform pg_temp.fail('instrument contract'); end if;
  insert into public.instrument_versions(id, user_id, account_id, symbol, currency, quantity_unit, tick_size, pip_size, tick_value,
      quantity_step, minimum_quantity, source, created_at)
    values (p_id, a.user_id, a.id, v_symbol, a.currency, v_unit, v_tick, v_pip, v_value, v_step, v_minimum, 'USER_DEFINED', p_at);
  insert into public.configuration_events(user_id, account_id, event_type, payload, recorded_at)
    values (a.user_id, a.id, 'INSTRUMENT_VERSION_CREATED', jsonb_build_object('instrument_version_id', p_id, 'symbol', v_symbol,
      'currency', a.currency), p_at);
end $$;

-- public.create_risk_policy_version at p_at: next strategy day unless immediate (with a reason of at least 5 chars).
create function pg_temp.seed_risk_version(p_account uuid, p_config jsonb, p_immediate boolean, p_reason text, p_at timestamptz) returns void
language plpgsql as $$
declare
  a public.accounts; v_reason text := nullif(btrim(p_reason), ''); v_max numeric; v_default numeric; v_trades bigint; v_min_rr numeric;
  v_rr text; v_news text; v_risk_cap numeric; v_loss_cap numeric; v_day date; v_count int; v_id uuid;
begin
  select * into a from public.accounts where id = p_account;
  perform private.require_object(p_config, array['maxRiskPercent','defaultRiskPercent','maxDailyTrades','minRR','rrPolicy','newsPolicy',
    'dailyRiskCap','dailyLossCap'], 'risk policy');
  v_max := private.decimal_input(private.json_text(p_config, 'maxRiskPercent'), 'maxRiskPercent');
  v_default := private.decimal_input(private.json_text(p_config, 'defaultRiskPercent'), 'defaultRiskPercent');
  v_trades := private.integer_input(p_config, 'maxDailyTrades', 1, 100);
  v_min_rr := private.decimal_input(private.json_text(p_config, 'minRR'), 'minRR');
  v_rr := private.json_text(p_config, 'rrPolicy');
  v_news := private.json_text(p_config, 'newsPolicy');
  v_risk_cap := private.money_input(private.json_text(p_config, 'dailyRiskCap'), 'dailyRiskCap');
  v_loss_cap := private.money_input(private.json_text(p_config, 'dailyLossCap'), 'dailyLossCap');
  if v_max is null or v_default is null or v_trades is null or v_min_rr is null or v_default > v_max or v_max > 100
     or v_rr not in ('BLOCK','WARN') or v_news not in ('BLOCK','WARN') then
    perform pg_temp.fail('risk policy values');
  end if;
  if p_immediate and (v_reason is null or length(v_reason) < 5) then perform pg_temp.fail('immediate risk change without a reason'); end if;
  v_day := private.strategy_day(p_at) + case when p_immediate then 0 else 1 end;
  select count(*) into v_count from public.risk_plan_versions where account_id = a.id;
  insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
      max_daily_trades, min_rr, rr_policy, news_policy, daily_risk_cap, daily_loss_cap, override_reason, created_at)
    values (a.user_id, a.id, 'Risk Plan V1.' || v_count, v_day, v_max, v_default, v_trades, v_min_rr, v_rr, v_news,
      v_risk_cap, v_loss_cap, case when p_immediate then v_reason end, p_at)
    returning id into v_id;
  insert into public.configuration_events(user_id, account_id, event_type, payload, recorded_at)
    values (a.user_id, a.id, 'RISK_VERSION_CREATED', jsonb_build_object('version_id', v_id, 'effective_day', v_day,
      'immediate', p_immediate, 'reason', case when p_immediate then v_reason end, 'default_risk_percent', v_default::text), p_at);
end $$;

-- public.record_account_values at p_at. The balance is the starting balance plus every result recorded so far, minus
-- recorded external losses; equity adds p_float (open positions). gross_loss_today stays null (V2).
create function pg_temp.seed_observation(p_account uuid, p_float numeric, p_at timestamptz) returns void
language plpgsql as $$
declare a public.accounts; v_start numeric; v_result numeric; v_balance numeric;
begin
  select * into a from public.accounts where id = p_account;
  select p.starting_balance into v_start from public.account_profiles p where p.account_id = a.id and p.recorded_at <= p_at
   order by p.id desc limit 1;
  v_result := (select coalesce(sum(o.net_pnl), 0) from public.trade_outcomes o where o.account_id = a.id and o.recorded_at <= p_at)
            + (select coalesce(sum(c.net_pnl), 0) from public.trade_unplanned_closes c where c.account_id = a.id and c.recorded_at <= p_at)
            - (select coalesce(sum(x.amount), 0) from public.external_loss_entries x where x.account_id = a.id and x.recorded_at <= p_at
                 and not exists (select 1 from public.external_loss_removals r where r.entry_id = x.id and r.recorded_at <= p_at));
  v_balance := round(v_start + v_result, 2);
  insert into public.account_observations(user_id, account_id, equity, balance, trading_day, recorded_at)
    values (a.user_id, a.id, private.positive_money(round(v_balance + coalesce(p_float, 0), 2)::text),
      private.positive_money(v_balance::text), private.strategy_day(p_at), p_at);
end $$;

-- public.create_planned_trade (revision 1) / public.revise_trade_draft (revision n + 1) at p_at: the free deterministic
-- check is persisted (risk_evaluations EXPLICIT_CHECK + setup_risk_checks) with the proposal and the revision.
create function pg_temp.seed_draft(p_account uuid, p_trade uuid, p_proposal_id uuid, p_request_key uuid, p_proposal jsonb,
  p_at timestamptz, p_expect text) returns void
language plpgsql as $$
declare a public.accounts; t public.trades; v_revision int; v jsonb; v_report jsonb; v_evaluation uuid;
begin
  select * into a from public.accounts where id = p_account;
  select * into t from public.trades where id = p_trade;
  if found then
    if t.account_id <> a.id or t.origin <> 'PLANNED' or private.trade_lifecycle(t.id) <> 'DRAFT' then
      perform pg_temp.fail(format('trade %s is not an editable draft', p_trade));
    end if;
    v_revision := (private.latest_revision(t.id)).revision + 1;
  else
    v_revision := 1;
  end if;
  if not exists (select 1 from public.instrument_versions i where i.account_id = a.id and i.id = (p_proposal ->> 'instrumentId')::uuid) then
    perform pg_temp.fail('proposal instrument does not belong to the account');
  end if;
  v := pg_temp.evaluate(a.id, p_proposal, p_at);
  v_report := v -> 'report';
  if v_report -> 'issues' @> '[{"code":"INVALID_INPUT"}]'::jsonb then perform pg_temp.fail('invalid proposal'); end if;
  perform pg_temp.expect_decision(v_report, p_expect, format('draft %s revision %s', p_trade, v_revision));
  insert into public.risk_evaluations(user_id, account_id, proposal, result, account_observation_id, strategy_version_id,
      risk_plan_version_id, instrument_version_id, source, recorded_at)
    values (a.user_id, a.id, p_proposal, v_report, (v ->> 'observationId')::uuid, (v ->> 'strategyId')::uuid,
      (v ->> 'riskPlanId')::uuid, (v ->> 'instrumentId')::uuid, 'EXPLICIT_CHECK', p_at)
    returning id into v_evaluation;
  insert into public.setup_proposals(id, user_id, account_id, strategy_version_id, instrument_version_id, risk_evaluation_id, proposal,
      request_key, created_at)
    values (p_proposal_id, a.user_id, a.id, (v ->> 'strategyId')::uuid, (v ->> 'instrumentId')::uuid, v_evaluation, p_proposal,
      p_request_key, p_at);
  insert into public.setup_risk_checks(user_id, account_id, proposal_id, risk_evaluation_id, created_at)
    values (a.user_id, a.id, p_proposal_id, v_evaluation, p_at);
  if v_revision = 1 then
    insert into public.trades(id, user_id, account_id, origin, created_at, request_key)
      values (p_trade, a.user_id, a.id, 'PLANNED', p_at, p_request_key);
  end if;
  insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id, created_at)
    values (p_proposal_id, p_trade, v_revision, a.user_id, a.id, p_at);
end $$;

-- public.check_trade_risk at p_at: re-evaluates the latest revision of a draft.
create function pg_temp.seed_check(p_trade uuid, p_at timestamptz, p_expect text) returns void
language plpgsql as $$
declare t public.trades; v_latest public.trade_revisions; s public.setup_proposals; v jsonb; v_evaluation uuid;
begin
  select * into t from public.trades where id = p_trade;
  if t.id is null or private.trade_lifecycle(t.id) <> 'DRAFT' then perform pg_temp.fail(format('trade %s is not a draft', p_trade)); end if;
  v_latest := private.latest_revision(t.id);
  select * into s from public.setup_proposals where id = v_latest.proposal_id;
  v := pg_temp.evaluate(t.account_id, s.proposal, p_at);
  perform pg_temp.expect_decision(v -> 'report', p_expect, format('check of %s', p_trade));
  insert into public.risk_evaluations(user_id, account_id, proposal, result, account_observation_id, strategy_version_id,
      risk_plan_version_id, instrument_version_id, source, recorded_at)
    values (t.user_id, t.account_id, s.proposal, v -> 'report', (v ->> 'observationId')::uuid, s.strategy_version_id,
      (v ->> 'riskPlanId')::uuid, s.instrument_version_id, 'EXPLICIT_CHECK', p_at)
    returning id into v_evaluation;
  insert into public.setup_risk_checks(user_id, account_id, proposal_id, risk_evaluation_id, created_at)
    values (t.user_id, t.account_id, s.id, v_evaluation, p_at);
end $$;

-- public.lock_trade at p_at (check_setup_risk(latest, true) -> assess_plan with p_lock): LOCK_RECHECK evaluation,
-- trade_plans (idempotency key = proposal id), PLAN_LOCKED event, setup_risk_checks, setup_locks, trade_plan_links.
create function pg_temp.seed_lock(p_trade uuid, p_plan uuid, p_at timestamptz) returns void
language plpgsql as $$
declare t public.trades; v_latest public.trade_revisions; s public.setup_proposals; v jsonb; v_report jsonb; v_evaluation uuid;
begin
  select * into t from public.trades where id = p_trade;
  if t.id is null or private.trade_lifecycle(t.id) <> 'DRAFT' then perform pg_temp.fail(format('trade %s is not a draft', p_trade)); end if;
  v_latest := private.latest_revision(t.id);
  select * into s from public.setup_proposals where id = v_latest.proposal_id;
  v := pg_temp.evaluate(t.account_id, s.proposal, p_at);
  v_report := v -> 'report';
  perform pg_temp.expect_decision(v_report, 'APPROVED', format('lock of %s at %s', p_trade, p_at));
  insert into public.risk_evaluations(user_id, account_id, proposal, result, account_observation_id, strategy_version_id,
      risk_plan_version_id, instrument_version_id, source, recorded_at)
    values (t.user_id, t.account_id, s.proposal, v_report, (v ->> 'observationId')::uuid, (v ->> 'strategyId')::uuid,
      (v ->> 'riskPlanId')::uuid, (v ->> 'instrumentId')::uuid, 'LOCK_RECHECK', p_at)
    returning id into v_evaluation;
  insert into public.trade_plans(id, user_id, account_id, strategy_version_id, risk_plan_version_id, instrument_version_id,
      account_observation_id, risk_evaluation_id, idempotency_key, proposal, risk_result, nominal_risk, trading_day, locked_at)
    values (p_plan, t.user_id, t.account_id, (v ->> 'strategyId')::uuid, (v ->> 'riskPlanId')::uuid, (v ->> 'instrumentId')::uuid,
      (v ->> 'observationId')::uuid, v_evaluation, s.id, s.proposal, v_report, (v_report #>> '{calculations,nominalRisk}')::numeric,
      private.strategy_day(p_at), p_at);
  insert into public.trade_events(user_id, account_id, plan_id, event_type, payload, occurred_at, recorded_at)
    values (t.user_id, t.account_id, p_plan, 'PLAN_LOCKED', jsonb_build_object('risk_evaluation_id', v_evaluation,
      'setup_status', 'NOT_EVALUATED', 'actor', t.user_id, 'source', 'USER_COMMAND'), p_at, p_at);
  insert into public.setup_risk_checks(user_id, account_id, proposal_id, risk_evaluation_id, created_at)
    values (t.user_id, t.account_id, s.id, v_evaluation, p_at);
  insert into public.setup_locks(proposal_id, user_id, account_id, plan_id, created_at) values (s.id, t.user_id, t.account_id, p_plan, p_at);
  insert into public.trade_plan_links(trade_id, plan_id, user_id, account_id, created_at) values (t.id, p_plan, t.user_id, t.account_id, p_at);
end $$;

-- public.record_planned_entry -> open_journal_trade at p_recorded_at. Quantity: p_quantity, else the plan's quantity
-- times p_size_factor rounded down to the contract step (an oversized fill when the factor is above 1).
create function pg_temp.seed_entry(p_trade uuid, p_execution uuid, p_entry text, p_quantity text, p_size_factor numeric,
  p_entered_at timestamptz, p_recorded_at timestamptz) returns void
language plpgsql as $$
declare t public.trades; p public.trade_plans; i public.instrument_versions; v_price numeric; v_qty numeric;
begin
  select * into t from public.trades where id = p_trade;
  p := private.linked_plan(t);
  select * into i from public.instrument_versions where id = p.instrument_version_id;
  v_price := private.positive_decimal(p_entry);
  if p_quantity is not null then
    v_qty := private.positive_decimal(p_quantity);
  else
    v_qty := greatest(trunc((p.risk_result #>> '{calculations,quantity}')::numeric * coalesce(p_size_factor, 1) / i.quantity_step) * i.quantity_step,
                      i.minimum_quantity);
  end if;
  if exists (select 1 from public.trade_executions e where e.plan_id = p.id) then perform pg_temp.fail('entry already recorded'); end if;
  if exists (select 1 from public.trade_dispositions d where d.plan_id = p.id) then perform pg_temp.fail('plan is skipped or cancelled'); end if;
  if p_entered_at < p.locked_at or p_entered_at > p_recorded_at then perform pg_temp.fail('entry must be after the lock and not after its recording'); end if;
  if mod(v_price, i.tick_size) <> 0 or mod(v_qty, i.quantity_step) <> 0 or v_qty < i.minimum_quantity then
    perform pg_temp.fail('fill must align with contract price and quantity increments');
  end if;
  if (p.proposal ->> 'direction' = 'LONG' and v_price <= (p.proposal ->> 'stop')::numeric)
     or (p.proposal ->> 'direction' = 'SHORT' and v_price >= (p.proposal ->> 'stop')::numeric) then
    perform pg_temp.fail('actual entry must remain on the valid side of the original stop');
  end if;
  insert into public.trade_executions(id, user_id, account_id, plan_id, entry_price, quantity, entered_at, initial_risk, recorded_at)
    values (p_execution, p.user_id, p.account_id, p.id, v_price, v_qty, p_entered_at, p.nominal_risk, p_recorded_at);
  insert into public.trade_events(user_id, account_id, plan_id, event_type, payload, occurred_at, recorded_at)
    values (p.user_id, p.account_id, p.id, 'TRADE_OPENED', jsonb_build_object('execution_id', p_execution, 'entry_price', v_price::text,
      'quantity', v_qty::text, 'initial_risk', p.nominal_risk::text, 'source', 'USER_REPORTED'), p_entered_at, p_recorded_at);
end $$;

-- public.close_planned_trade -> close_journal_trade (FULL_CLOSE_V1) at p_recorded_at. Fees: p_fees, else the filled
-- quantity times p_fee_per_unit (commission), rounded to cents.
create function pg_temp.seed_close(p_trade uuid, p_outcome uuid, p_exit text, p_exited_at timestamptz, p_fees text,
  p_fee_per_unit numeric, p_recorded_at timestamptz) returns void
language plpgsql as $$
declare
  t public.trades; p public.trade_plans; i public.instrument_versions; e public.trade_executions;
  v_price numeric; v_fees text; v_fee numeric; v_gross numeric; v_net numeric; v_r numeric; v_verdict text;
begin
  select * into t from public.trades where id = p_trade;
  p := private.linked_plan(t);
  select * into e from public.trade_executions where plan_id = p.id;
  if e.id is null then perform pg_temp.fail('record the actual entry before closing'); end if;
  select * into i from public.instrument_versions where id = p.instrument_version_id;
  v_price := private.positive_decimal(p_exit);
  v_fees := coalesce(p_fees, round(e.quantity * coalesce(p_fee_per_unit, 0), 2)::text);
  if v_fees !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' then perform pg_temp.fail('fees must be a nonnegative amount with at most two decimals'); end if;
  v_fee := v_fees::numeric;
  if exists (select 1 from public.trade_outcomes o where o.plan_id = p.id) then perform pg_temp.fail('trade already closed'); end if;
  if p_exited_at < e.entered_at or p_exited_at > p_recorded_at then perform pg_temp.fail('exit must be after entry and not after its recording'); end if;
  if mod(v_price, i.tick_size) <> 0 then perform pg_temp.fail('exit must align with the contract tick size'); end if;
  if exists (select 1 from public.trade_events x where x.plan_id = p.id and x.event_type in ('PARTIAL_CLOSED','POSITION_ADDED')) then
    perform pg_temp.fail('multi-leg position');
  end if;
  v_gross := (v_price - e.entry_price) * case when p.proposal ->> 'direction' = 'LONG' then 1 else -1 end / i.tick_size * i.tick_value * e.quantity;
  v_net := v_gross - v_fee;
  v_r := v_net / e.initial_risk;
  v_verdict := case when v_net > 0 then 'WIN' when v_net < 0 then 'LOSS' else 'BREAKEVEN' end;
  insert into public.trade_outcomes(id, user_id, account_id, plan_id, execution_id, exit_price, exited_at, fees, gross_pnl, net_pnl,
      realized_r, outcome, recorded_at)
    values (p_outcome, p.user_id, p.account_id, p.id, e.id, v_price, p_exited_at, v_fee, v_gross, v_net, v_r, v_verdict, p_recorded_at);
  insert into public.trade_events(user_id, account_id, plan_id, event_type, payload, occurred_at, recorded_at)
    values (p.user_id, p.account_id, p.id, 'TRADE_CLOSED', jsonb_build_object('outcome_id', p_outcome, 'exit_price', v_price::text,
      'fees', v_fee::text, 'realized_r', v_r::text, 'outcome', v_verdict, 'calculation_version', 'FULL_CLOSE_V1'), p_exited_at, p_recorded_at);
end $$;

-- public.set_planned_disposition -> set_journal_disposition at p_at (skip or cancel a locked plan before entry).
create function pg_temp.seed_disposition(p_trade uuid, p_status text, p_reason text, p_at timestamptz) returns void
language plpgsql as $$
declare t public.trades; p public.trade_plans;
begin
  select * into t from public.trades where id = p_trade;
  p := private.linked_plan(t);
  if p_status not in ('SKIPPED','CANCELLED') or length(btrim(coalesce(p_reason, ''))) not between 1 and 5000 then
    perform pg_temp.fail('disposition status or reason');
  end if;
  if exists (select 1 from public.trade_executions e where e.plan_id = p.id) then perform pg_temp.fail('an executed trade must be closed'); end if;
  insert into public.trade_dispositions(user_id, account_id, plan_id, status, reason, recorded_at)
    values (p.user_id, p.account_id, p.id, p_status, p_reason, p_at);
  insert into public.trade_events(user_id, account_id, plan_id, event_type, payload, occurred_at, recorded_at)
    values (p.user_id, p.account_id, p.id, 'PLAN_CANCELLED', jsonb_build_object('status', p_status, 'reason', p_reason), p_at, p_at);
end $$;

-- public.discard_trade_draft / complete_trade_review / reopen_trade_review at p_at.
create function pg_temp.seed_lifecycle(p_trade uuid, p_event text, p_reason text, p_at timestamptz) returns void
language plpgsql as $$
declare t public.trades; v_state text; v_reason text := nullif(btrim(p_reason), '');
begin
  select * into t from public.trades where id = p_trade;
  v_state := private.trade_lifecycle(t.id);
  if (p_event = 'DRAFT_DISCARDED' and v_state <> 'DRAFT') or (p_event = 'REVIEW_COMPLETED' and v_state <> 'CLOSED')
     or (p_event = 'REVIEW_REOPENED' and v_state <> 'REVIEWED') then
    perform pg_temp.fail(format('%s is not allowed while trade %s is %s', p_event, p_trade, v_state));
  end if;
  insert into public.trade_lifecycle_events(user_id, account_id, trade_id, event, reason, recorded_at)
    values (t.user_id, t.account_id, t.id, p_event, case when p_event = 'REVIEW_COMPLETED' then null else v_reason end, p_at);
end $$;

-- public.record_live_trade at p_at (a LIVE_FIRST trade and its first entry-facts row).
create function pg_temp.seed_live(p_account uuid, p_trade uuid, p_facts uuid, p_request_key uuid, p_input jsonb, p_at timestamptz) returns void
language plpgsql as $$
declare a public.accounts; v public.trade_position_facts;
begin
  select * into a from public.accounts where id = p_account;
  perform private.require_object(p_input, array['instrumentId','symbol','direction','entryModel','entryPrice','enteredAt','quantity',
    'initialStop','riskAmount'], 'live trade');
  v := private.position_input(a, p_input);
  if v.symbol is null or v.direction is null then perform pg_temp.fail('a live trade needs a symbol and a direction'); end if;
  perform private.check_position(v, p_at);
  insert into public.trades(id, user_id, account_id, origin, created_at, request_key) values (p_trade, a.user_id, a.id, 'LIVE_FIRST', p_at, p_request_key);
  insert into public.trade_position_facts(id, user_id, account_id, trade_id, instrument_version_id, symbol, direction, entry_model,
      entry_price, entered_at, quantity, initial_stop, risk_amount, source, recorded_at, request_key)
    values (p_facts, a.user_id, a.id, p_trade, v.instrument_version_id, v.symbol, v.direction, v.entry_model, v.entry_price, v.entered_at,
      v.quantity, v.initial_stop, v.risk_amount, 'USER', p_at, p_request_key);
end $$;

-- public.complete_live_entry at p_at: fills entry facts that are still unknown, once each.
create function pg_temp.seed_complete_entry(p_trade uuid, p_facts uuid, p_request_key uuid, p_input jsonb, p_at timestamptz) returns void
language plpgsql as $$
declare t public.trades; a public.accounts; v public.trade_position_facts; cur public.trade_position_facts; merged public.trade_position_facts;
begin
  select * into t from public.trades where id = p_trade;
  if t.origin = 'PLANNED' then perform pg_temp.fail('planned trades record their entry through the locked plan'); end if;
  perform private.require_object(p_input, array['instrumentId','entryModel','entryPrice','enteredAt','quantity','initialStop','riskAmount'], 'entry details');
  select * into a from public.accounts where id = t.account_id;
  v := private.position_input(a, p_input);
  if exists (select 1 from public.trade_unplanned_closes c where c.trade_id = t.id) then perform pg_temp.fail('entry details of a closed trade'); end if;
  cur := private.effective_position(t.id);
  if (v.instrument_version_id is not null and cur.instrument_version_id is not null) or (v.entry_model is not null and cur.entry_model is not null)
     or (v.entry_price is not null and cur.entry_price is not null) or (v.entered_at is not null and cur.entered_at is not null)
     or (v.quantity is not null and cur.quantity is not null) or (v.initial_stop is not null and cur.initial_stop is not null)
     or (v.risk_amount is not null and cur.risk_amount is not null) then
    perform pg_temp.fail('recorded entry details cannot be changed');
  end if;
  merged := cur;
  merged.instrument_version_id := coalesce(cur.instrument_version_id, v.instrument_version_id);
  merged.entry_model := coalesce(cur.entry_model, v.entry_model);
  merged.entry_price := coalesce(cur.entry_price, v.entry_price);
  merged.entered_at := coalesce(cur.entered_at, v.entered_at);
  merged.quantity := coalesce(cur.quantity, v.quantity);
  merged.initial_stop := coalesce(cur.initial_stop, v.initial_stop);
  merged.risk_amount := coalesce(cur.risk_amount, v.risk_amount);
  perform private.check_position(merged, t.created_at);
  insert into public.trade_position_facts(id, user_id, account_id, trade_id, instrument_version_id, entry_model, entry_price, entered_at,
      quantity, initial_stop, risk_amount, source, recorded_at, request_key)
    values (p_facts, t.user_id, t.account_id, t.id, v.instrument_version_id, v.entry_model, v.entry_price, v.entered_at, v.quantity,
      v.initial_stop, v.risk_amount, 'USER', p_at, p_request_key);
end $$;

-- public.close_live_trade (UNPLANNED_CLOSE_V1) at p_at. Input {exitPrice?, exitedAt, fees?, netPnl?}.
create function pg_temp.seed_close_live(p_trade uuid, p_input jsonb, p_at timestamptz) returns void
language plpgsql as $$
declare
  t public.trades; pos public.trade_position_facts; i public.instrument_versions;
  v_exit numeric; v_exited timestamptz; v_fees numeric; v_reported numeric;
  v_gross numeric; v_net numeric; v_source text; v_basis numeric; v_basis_source text; v_r numeric;
begin
  select * into t from public.trades where id = p_trade;
  if t.origin = 'PLANNED' then perform pg_temp.fail('planned trades are closed through their locked plan'); end if;
  perform private.require_object(p_input, array['exitPrice','exitedAt','fees','netPnl'], 'close');
  v_exit := private.decimal_input(private.json_text(p_input, 'exitPrice'), 'exitPrice');
  v_exited := private.instant_input(private.json_text(p_input, 'exitedAt'), 'exitedAt');
  if v_exited is null then perform pg_temp.fail('exitedAt is required'); end if;
  v_fees := coalesce(private.money_input(private.json_text(p_input, 'fees'), 'fees', true), 0);
  v_reported := private.signed_money_input(private.json_text(p_input, 'netPnl'), 'netPnl');
  if exists (select 1 from public.trade_unplanned_closes c where c.trade_id = t.id) then perform pg_temp.fail('trade already closed'); end if;
  pos := private.effective_position(t.id);
  if v_exited > p_at then perform pg_temp.fail('the exit time must not be later than its recording'); end if;
  if v_exited < pos.entered_at then perform pg_temp.fail('the exit time must not be before the entry time'); end if;
  select * into i from public.instrument_versions where id = pos.instrument_version_id;
  if i.id is not null and pos.entry_price is not null and pos.quantity is not null and v_exit is not null then
    if v_reported is not null then perform pg_temp.fail('net P&L is calculated from the recorded prices and size'); end if;
    v_gross := trim_scale((v_exit - pos.entry_price) * case when pos.direction = 'LONG' then 1 else -1 end * i.tick_value * pos.quantity / i.tick_size);
    v_net := v_gross - v_fees;
    v_source := 'CALCULATED';
  else
    if v_reported is null then perform pg_temp.fail('report the net P&L; it cannot be calculated'); end if;
    v_net := v_reported;
    v_source := 'USER_REPORTED';
  end if;
  if pos.risk_amount is not null then
    v_basis := trim_scale(pos.risk_amount);
    v_basis_source := 'USER_REPORTED';
  elsif i.id is not null and pos.entry_price is not null and pos.initial_stop is not null and pos.quantity is not null then
    v_basis := trim_scale(abs(pos.entry_price - pos.initial_stop) * i.tick_value * pos.quantity / i.tick_size);
    v_basis_source := 'DERIVED';
  end if;
  if v_basis is not null then v_r := trim_scale(v_net / v_basis); end if;
  insert into public.trade_unplanned_closes(trade_id, user_id, account_id, exit_price, exited_at, fees, gross_pnl, net_pnl, pnl_source,
      risk_basis, risk_basis_source, realized_r, outcome, recorded_at)
    values (t.id, t.user_id, t.account_id, v_exit, v_exited, v_fees, v_gross, trim_scale(v_net), v_source, v_basis, v_basis_source, v_r,
      case when v_net > 0 then 'WIN' when v_net < 0 then 'LOSS' else 'BREAKEVEN' end, p_at);
end $$;

-- public.add_journal_entry at p_at: details validated per kind; phase and state computed from the records so far.
create function pg_temp.seed_journal(p_trade uuid, p_entry uuid, p_request_key uuid, p_kind text, p_body text, p_details jsonb,
  p_at timestamptz) returns void
language plpgsql as $$
declare
  t public.trades; v_body text := nullif(btrim(p_body, E' \t\r\n'), '');
  v_details jsonb := coalesce(jsonb_strip_nulls(p_details), '{}'::jsonb);
begin
  select * into t from public.trades where id = p_trade;
  if length(v_body) > 5000 then perform pg_temp.fail('journal body too long'); end if;
  perform private.check_journal_details(p_kind, v_body, v_details, (private.trade_instrument(t)).tick_size);
  insert into public.trade_journal_entries(id, user_id, account_id, trade_id, kind, body, details, phase, state_at_creation, recorded_at, request_key)
    values (p_entry, t.user_id, t.account_id, t.id, p_kind, v_body, v_details, private.trade_phase(t.id), private.trade_lifecycle(t.id), p_at,
      p_request_key);
end $$;

-- public.register_trade_evidence at p_at (the bytes are already in the trade-evidence bucket at the computed path).
create function pg_temp.seed_evidence(p_user uuid, p_record jsonb, p_at timestamptz) returns void
language plpgsql as $$
declare t public.trades; v_id uuid; v_label text; v_timeframe text; v_caption text; v_mime text; v_size bigint; v_width bigint; v_height bigint;
begin
  perform private.require_object(p_record, array['id','tradeId','label','timeframe','caption','originalFilename','mimeType','byteSize','sha256',
    'width','height','captureMethod'], 'evidence');
  v_id := private.uuid_input(private.json_text(p_record, 'id'), 'id');
  select * into t from public.trades where id = private.uuid_input(private.json_text(p_record, 'tradeId'), 'tradeId') and user_id = p_user;
  if t.id is null then perform pg_temp.fail('evidence trade not found'); end if;
  v_label := private.json_text(p_record, 'label');
  v_timeframe := private.json_text(p_record, 'timeframe');
  v_caption := nullif(btrim(private.json_text(p_record, 'caption')), '');
  v_mime := private.json_text(p_record, 'mimeType');
  v_size := private.integer_input(p_record, 'byteSize', 1, 4194304);
  v_width := private.integer_input(p_record, 'width', 1, 2147483647);
  v_height := private.integer_input(p_record, 'height', 1, 2147483647);
  if v_label not in ('HTF','CONTEXT','PRE_ENTRY','ENTRY','MANAGEMENT','EXIT','OTHER') or v_timeframe not in ('DAILY','H4','H1','M30','M15','M5','M3','OTHER')
     or length(v_caption) > 200 or v_mime not in ('image/png','image/jpeg','image/webp') or v_width * v_height > 40000000
     or private.json_text(p_record, 'sha256') !~ '^[0-9a-f]{64}$' or private.json_text(p_record, 'captureMethod') not in ('PASTE','DROP','FILE','CAMERA') then
    perform pg_temp.fail('evidence record');
  end if;
  if (select count(*) from public.trade_evidence x where x.trade_id = t.id
        and not exists (select 1 from public.trade_evidence_removals r where r.evidence_id = x.id)) >= 24 then
    perform pg_temp.fail('a trade supports 24 active screenshots');
  end if;
  insert into public.trade_evidence(id, user_id, account_id, trade_id, storage_path, label, timeframe, caption, original_filename, mime_type,
      byte_size, sha256, width, height, phase, state_at_creation, capture_method, recorded_at)
    values (v_id, t.user_id, t.account_id, t.id, p_user::text || '/' || t.id::text || '/' || v_id::text, v_label, v_timeframe, v_caption,
      private.json_text(p_record, 'originalFilename'), v_mime, v_size, private.json_text(p_record, 'sha256'), v_width, v_height,
      private.trade_phase(t.id), private.trade_lifecycle(t.id), private.json_text(p_record, 'captureMethod'), p_at);
end $$;

-- public.set_trade_tags at p_at (the latest set wins).
create function pg_temp.seed_tags(p_trade uuid, p_grade text, p_liquidity text, p_mss text, p_tags text[], p_at timestamptz) returns void
language plpgsql as $$
declare t public.trades;
begin
  select * into t from public.trades where id = p_trade;
  if not private.valid_tags(coalesce(p_tags, '{}')) then perform pg_temp.fail('tags'); end if;
  insert into public.trade_tag_sets(user_id, account_id, trade_id, setup_grade, liquidity_context, mss_timeframe, tags, recorded_at)
    values (t.user_id, t.account_id, t.id, p_grade, p_liquidity, p_mss, coalesce(p_tags, '{}'), p_at);
end $$;

-- public.add_external_loss / remove_external_loss at p_at (dated to the strategy day of p_at).
create function pg_temp.seed_external_loss(p_account uuid, p_id uuid, p_amount text, p_note text, p_at timestamptz) returns void
language plpgsql as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id = p_account;
  insert into public.external_loss_entries(id, user_id, account_id, trading_day, amount, note, recorded_at, request_key)
    values (p_id, a.user_id, a.id, private.strategy_day(p_at), private.money_input(p_amount, 'amount'), nullif(btrim(p_note), ''), p_at, p_id);
end $$;

create function pg_temp.seed_external_loss_removal(p_entry uuid, p_reason text, p_at timestamptz) returns void
language plpgsql as $$
declare e public.external_loss_entries;
begin
  select * into e from public.external_loss_entries where id = p_entry;
  insert into public.external_loss_removals(entry_id, user_id, account_id, reason, recorded_at)
    values (e.id, e.user_id, e.account_id, nullif(btrim(p_reason), ''), p_at);
end $$;

-- public.save_daily_context at p_at ("Today's plan · notes").
create function pg_temp.seed_daily_context(p_account uuid, p_narrative text, p_at timestamptz) returns void
language plpgsql as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id = p_account;
  insert into public.daily_contexts(user_id, account_id, trading_day, narrative, recorded_at)
    values (a.user_id, a.id, private.strategy_day(p_at), p_narrative, p_at);
end $$;
