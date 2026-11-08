-- Trading OS V2: Risk Engine 1.1 / report 1.2 and daily usage (docs/V2_ARCHITECTURE.md §6, §0.4, §4, §5.1).
-- Additive only. The V1 engine functions (private.evaluate_risk, private.risk_report) keep their bodies and
-- signatures: stored 1.0/1.1 reports keep their meaning. Every engine path (private.assess_plan and
-- private.check_proposal_risk, reached through evaluate_trade_plan, save_setup_proposal, lock_trade_plan and the
-- trade-aware public.check_setup_risk of 0015) now evaluates with private.risk_report_v12, the risk plan chosen by
-- private.active_risk_plan (precedence fix C9) and the daily usage of private.daily_usage.
-- src/domain/risk.ts mirrors private.risk_report_v12 byte for byte except evaluatedAt (parity-tested).

-- ---------------------------------------------------------------------------------------------------------
-- §6.2 Daily usage of the strategy day of p_now. p_exclude_plan leaves one plan's own reservation out (the
-- recheck of a locked plan must not count itself).
--   plannedSlots/plannedRisk   plans locked for the day (closed or skipped plans keep their slot, V1 semantics)
--   unplannedTrades/Risk       live-first/imported trades entered that day (entry day = strategy day of the
--                              effective entered_at, else of the first facts row), with their known risk basis
--   openExposure               risk still at stake: the day's plans without outcome or disposition, executed plans
--                              of earlier days without outcome (greatest(nominal, actual initial risk of the fill)),
--                              open live-first/imported trades of any day (known basis only)
--   realizedLoss               losses of planned outcomes and unplanned closes exited that day
--   externalLoss               non-removed external losses of the day
--   legacyReportedLoss         the V1 manual total of the latest observation, when it is of that day
--   lossTotal                  greatest(coalesce(legacyReportedLoss, 0), realizedLoss + externalLoss)
-- Risk basis of a trade without a plan: the basis frozen by its close, else the reported risk amount, else
-- |entry − stop| × tick value × quantity ÷ tick size when all are known (the 0015 close and ledger formula).
-- ---------------------------------------------------------------------------------------------------------
create function private.daily_usage(p_account_id uuid, p_now timestamptz, p_exclude_plan uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_day date := private.strategy_day(p_now);
  v_planned_slots int; v_planned_risk numeric; v_planned_open numeric;
  v_unplanned_trades int; v_unplanned_risk numeric; v_unplanned_unknown int;
  v_unplanned_open numeric; v_open_unknown int; v_risk_unknown_trades int;
  v_realized numeric; v_external numeric; v_legacy numeric; v_observation public.account_observations;
begin
  select count(*)::int, coalesce(sum(p.nominal_risk), 0) into v_planned_slots, v_planned_risk
    from public.trade_plans p
   where p.account_id = p_account_id and p.trading_day = v_day and p.id is distinct from p_exclude_plan;

  select coalesce(sum(greatest(p.nominal_risk, coalesce(
           case when e.id is not null and p.proposal ->> 'stop' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$'
                then abs(e.entry_price - (p.proposal ->> 'stop')::numeric) * i.tick_value * e.quantity / i.tick_size end, 0))), 0)
    into v_planned_open
    from public.trade_plans p
    join public.instrument_versions i on i.id = p.instrument_version_id
    left join public.trade_executions e on e.plan_id = p.id
   where p.account_id = p_account_id and p.id is distinct from p_exclude_plan
     and not exists (select 1 from public.trade_outcomes o where o.plan_id = p.id)
     and ((p.trading_day = v_day and not exists (select 1 from public.trade_dispositions d where d.plan_id = p.id))
          or (p.trading_day < v_day and e.id is not null));

  -- Trades without a plan that can matter on v_day: every open one, and closed ones recorded since the day before
  -- (an entry never lies after the trade was recorded: record_live_trade, complete_live_entry and imports refuse
  -- entry times later than the recording, so a trade entered on v_day was created no earlier than v_day − 1).
  with candidates as (
    select t.id, f.entered_at, f.recorded_at as first_recorded_at, f.instrument_version_id, f.entry_price,
           f.initial_stop, f.quantity, f.risk_amount, c.trade_id is not null as closed, c.risk_basis as closed_basis
      from public.trades t
      left join public.trade_unplanned_closes c on c.trade_id = t.id
      cross join lateral private.effective_position(t.id) f
     where t.account_id = p_account_id and t.origin in ('LIVE_FIRST','IMPORTED')
       and (c.trade_id is null or t.created_at >= p_now - interval '2 days')
  ), positions as (
    select x.closed,
           private.strategy_day(coalesce(x.entered_at, x.first_recorded_at)) as entry_day,
           case when x.closed then x.closed_basis
                else coalesce(x.risk_amount, abs(x.entry_price - x.initial_stop) * i.tick_value * x.quantity / i.tick_size) end as basis
      from candidates x
      left join public.instrument_versions i on i.id = x.instrument_version_id
  )
  select count(*) filter (where entry_day = v_day)::int,
         coalesce(sum(basis) filter (where entry_day = v_day), 0),
         count(*) filter (where entry_day = v_day and basis is null)::int,
         coalesce(sum(basis) filter (where not closed), 0),
         count(*) filter (where not closed and basis is null)::int,
         count(*) filter (where basis is null and (entry_day = v_day or not closed))::int
    into v_unplanned_trades, v_unplanned_risk, v_unplanned_unknown, v_unplanned_open, v_open_unknown, v_risk_unknown_trades
    from positions;

  select coalesce(sum(greatest(-o.net_pnl, 0)), 0) into v_realized
    from public.trade_outcomes o where o.account_id = p_account_id and private.strategy_day(o.exited_at) = v_day;
  v_realized := v_realized + (select coalesce(sum(greatest(-c.net_pnl, 0)), 0)
    from public.trade_unplanned_closes c where c.account_id = p_account_id and private.strategy_day(c.exited_at) = v_day);

  select coalesce(sum(x.amount), 0) into v_external
    from public.external_loss_entries x
   where x.account_id = p_account_id and x.trading_day = v_day
     and not exists (select 1 from public.external_loss_removals r where r.entry_id = x.id);

  select * into v_observation from public.account_observations o
   where o.account_id = p_account_id order by o.recorded_at desc, o.id desc limit 1;
  if v_observation.trading_day = v_day then v_legacy := v_observation.gross_loss_today; end if;

  return jsonb_build_object(
    'day', to_char(v_day, 'YYYY-MM-DD'),
    'plannedSlots', v_planned_slots, 'plannedRisk', trim_scale(v_planned_risk)::text,
    'unplannedTrades', v_unplanned_trades, 'unplannedRisk', trim_scale(v_unplanned_risk)::text,
    'unplannedRiskUnknown', v_unplanned_unknown,
    'realizedLoss', trim_scale(v_realized)::text, 'externalLoss', trim_scale(v_external)::text,
    'legacyReportedLoss', trim_scale(v_legacy)::text,
    'openExposure', trim_scale(v_planned_open + v_unplanned_open)::text, 'openRiskUnknown', v_open_unknown,
    'riskUnknownTrades', v_risk_unknown_trades,
    'lossTotal', trim_scale(greatest(coalesce(v_legacy, 0), v_realized + v_external))::text);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Engine 1.1 helpers. Messages are the §6.5 sentences with exact values: percentages, RR and money canonical and
-- padded to at least 2 decimals, money followed by the account currency code (the UI renders from code + params).
-- ---------------------------------------------------------------------------------------------------------
create function private.risk_padded(p_value numeric) returns text
language sql immutable set search_path = '' as $$
  select case when scale(trim_scale(p_value)) < 2 then round(p_value, 2)::text else trim_scale(p_value)::text end
$$;

create function private.risk_money(p_value numeric, p_currency text) returns text
language sql immutable set search_path = '' as $$
  select private.risk_padded(p_value) || ' ' || p_currency
$$;

create function private.risk_issue(p_code text, p_severity text, p_message text, p_params jsonb default '{}'::jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_array(jsonb_build_object('code', p_code, 'severity', p_severity, 'message', p_message, 'params', p_params))
$$;

-- A JSON string holding a positive decimal with at most 12 integer digits and 8 decimals.
create function private.risk_positive_price(p_value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then return false; end if;
  if (p_value #>> '{}') !~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then return false; end if;
  return (p_value #>> '{}')::numeric > 0;
end $$;

-- Invalid proposal keys in proposal-schema order: null for a valid proposal; '{}' when the value is not a JSON object
-- or only carries unknown keys. The narrative is trimmed of ECMAScript white space and line terminators (the same
-- set as src/domain/risk.ts) and counted in characters.
create function private.risk_invalid_fields(p jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v_keys constant text[] := array['instrumentId','direction','model','entry','stop','target','riskPercent','narrative',
    'contractConfirmed','news','contradiction'];
  v_blank constant text := chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200)
    || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
  v_invalid text[] := '{}';
  v_key text; v_value jsonb; v_ok boolean; v_length int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return '{}'; end if;
  foreach v_key in array v_keys loop
    v_value := p -> v_key;
    v_ok := v_value is not null and case v_key
      when 'instrumentId' then jsonb_typeof(v_value) = 'string'
        and (v_value #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      when 'direction' then jsonb_typeof(v_value) = 'string' and (v_value #>> '{}') in ('LONG','SHORT')
      when 'model' then jsonb_typeof(v_value) = 'string' and (v_value #>> '{}') in ('OB_FIRST_TOUCH','OTE')
      when 'stop' then jsonb_typeof(v_value) = 'null' or private.risk_positive_price(v_value)
      when 'narrative' then jsonb_typeof(v_value) = 'string'
      when 'contractConfirmed' then jsonb_typeof(v_value) = 'boolean'
      when 'news' then jsonb_typeof(v_value) = 'string' and (v_value #>> '{}') in ('UNKNOWN','CLEAR','RESTRICTED')
      when 'contradiction' then jsonb_typeof(v_value) = 'boolean'
      else private.risk_positive_price(v_value)
    end;
    if v_ok and v_key = 'narrative' then
      v_length := char_length(btrim(v_value #>> '{}', v_blank));
      v_ok := v_length between 1 and 5000;
    end if;
    if v_ok is not true then v_invalid := v_invalid || v_key; end if;
  end loop;
  if cardinality(v_invalid) = 0 and not exists (select 1 from jsonb_object_keys(p) k where k <> all (v_keys)) then
    return null;
  end if;
  return v_invalid;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §6.3 Engine 1.1 core: issues (code, severity, message, params) and canonical calculations.
-- Sizing is exact: budget = trunc(equity × risk% × 0.01, 2); quantity = div(budget × tick, distance × tick value ×
-- step) × step; stop ticks, reward ticks and pips are truncated to 20 decimals (they only fail to terminate off the
-- tick grid, which OFF_TICK blocks); plannedRR = div(reward × 10^8, distance) / 10^8. MAX_TRADES, DEAD_POOL and
-- STALE_EQUITY are evaluated even when invalid input, a missing stop, wrong geometry or the sizing invariant stops
-- sizing. A failed sizing invariant is a BLOCK finding, never an exception.
-- ---------------------------------------------------------------------------------------------------------
create function private.evaluate_risk_v12(p jsonb, a public.accounts, o public.account_observations,
  r public.risk_plan_versions, i public.instrument_versions, s public.strategy_versions, p_now timestamptz,
  p_usage jsonb, p_duplicate boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_day date := private.strategy_day(p_now);
  v_session text := private.strategy_session(p_now);
  v_dash constant text := chr(8211);
  v_minus constant text := chr(8722);
  v_planned_slots int := (p_usage ->> 'plannedSlots')::int;
  v_unplanned_trades int := (p_usage ->> 'unplannedTrades')::int;
  v_slots int := (p_usage ->> 'plannedSlots')::int + (p_usage ->> 'unplannedTrades')::int;
  v_risk_used numeric := (p_usage ->> 'plannedRisk')::numeric + (p_usage ->> 'unplannedRisk')::numeric;
  v_loss_total numeric := (p_usage ->> 'lossTotal')::numeric;
  v_open numeric := (p_usage ->> 'openExposure')::numeric;
  v_unknown int := (p_usage ->> 'riskUnknownTrades')::int;
  v_stale boolean := o.trading_day is distinct from v_day;
  v_issues jsonb := '[]';
  v_calc jsonb;
  v_invalid text[];
  v_entry numeric; v_stop numeric; v_target numeric; v_risk_pct numeric;
  v_distance numeric; v_reward numeric; v_budget numeric; v_permitted numeric; v_qty numeric;
  v_ticks numeric; v_nominal numeric; v_rr numeric; v_remaining numeric;
  v_dead_pool text := 'Trading is not permitted during Dead Pool (12:00' || chr(8211) || '18:00 UTC' || chr(8722)
    || '5). New plans can be locked from 18:00.';
begin
  <<engine>>
  begin
    v_invalid := private.risk_invalid_fields(p);
    if v_invalid is not null then
      v_issues := v_issues || private.risk_issue('INVALID_INPUT', 'BLOCK',
        coalesce((select string_agg(case f.key
            when 'instrumentId' then 'Choose an instrument from this trading account.'
            when 'direction' then 'Choose a direction: long or short.'
            when 'model' then 'Choose an entry model.'
            when 'entry' then 'Entry price must be a positive number with up to 8 decimals.'
            when 'stop' then 'Stop loss must be a positive number with up to 8 decimals.'
            when 'target' then 'Target price must be a positive number with up to 8 decimals.'
            when 'riskPercent' then 'Risk per trade must be a positive percentage with up to 8 decimals.'
            when 'narrative' then 'Add your thesis: why this trade, and what would invalidate it.'
            when 'contractConfirmed' then 'Confirm whether the contract values match your broker.'
            when 'news' then 'Choose the economic news status.'
            when 'contradiction' then 'Answer whether the setup contradicts a strategy rule.'
          end, ' ' order by f.position) from unnest(v_invalid) with ordinality as f(key, position)),
          'Some trade details are missing or invalid. Review the plan and try again.'),
        jsonb_build_object('fields', array_to_string(v_invalid, ',')));
      exit engine;
    end if;
    if lower(p ->> 'instrumentId') <> lower(i.id::text) or i.currency <> a.currency then
      v_issues := v_issues || private.risk_issue('INSTRUMENT_MISMATCH', 'BLOCK',
        case when i.currency <> a.currency then i.symbol || ' is valued in ' || i.currency || ', but this account uses ' || a.currency || '.'
             else 'This instrument does not belong to the selected trading account.' end,
        jsonb_build_object('symbol', i.symbol, 'instrumentCurrency', i.currency, 'accountCurrency', a.currency));
    end if;
    if not (p -> 'contractConfirmed')::boolean then
      v_issues := v_issues || private.risk_issue('CONTRACT_UNCONFIRMED', 'BLOCK',
        'Confirm that the ' || i.symbol || ' contract values match your broker.', jsonb_build_object('symbol', i.symbol));
    end if;
    if jsonb_typeof(p -> 'stop') = 'null' then
      v_issues := v_issues || private.risk_issue('MISSING_STOP', 'BLOCK', 'A stop loss is required.');
      exit engine;
    end if;
    v_entry := (p ->> 'entry')::numeric;
    v_stop := (p ->> 'stop')::numeric;
    v_target := (p ->> 'target')::numeric;
    v_risk_pct := (p ->> 'riskPercent')::numeric;
    if not ((p ->> 'direction' = 'LONG' and v_stop < v_entry and v_target > v_entry)
         or (p ->> 'direction' = 'SHORT' and v_stop > v_entry and v_target < v_entry)) then
      v_issues := v_issues || private.risk_issue('PRICE_GEOMETRY', 'BLOCK',
        case when p ->> 'direction' = 'LONG' then 'For a long trade, the stop must be below entry and the target above entry.'
             else 'For a short trade, the stop must be above entry and the target below entry.' end,
        jsonb_build_object('direction', p ->> 'direction'));
      exit engine;
    end if;
    if mod(v_entry, i.tick_size) <> 0 or mod(v_stop, i.tick_size) <> 0 or mod(v_target, i.tick_size) <> 0 then
      v_issues := v_issues || private.risk_issue('OFF_TICK', 'BLOCK',
        'Prices must align to the ' || i.symbol || ' tick size of ' || trim_scale(i.tick_size)::text || '.',
        jsonb_build_object('symbol', i.symbol, 'tick', trim_scale(i.tick_size)::text));
    end if;
    v_distance := abs(v_entry - v_stop);
    v_reward := abs(v_target - v_entry);
    v_budget := trunc(o.equity * v_risk_pct * 0.01, 2);
    v_permitted := trunc(o.equity * r.max_risk_percent * 0.01, 2);
    v_qty := div(v_budget * i.tick_size, v_distance * i.tick_value * i.quantity_step) * i.quantity_step;
    v_ticks := div(v_distance * 100000000000000000000, i.tick_size) * 0.00000000000000000001;
    v_nominal := v_qty * v_ticks * i.tick_value;
    if v_nominal > v_budget then
      v_issues := v_issues || private.risk_issue('SIZING_INVARIANT', 'BLOCK',
        'Position sizing failed an internal safety check. Nothing was locked.');
      exit engine;
    end if;
    v_rr := div(v_reward * 100000000, v_distance) * 0.00000001;
    v_calc := jsonb_build_object(
      'budget', trim_scale(v_budget)::text,
      'permittedRisk', trim_scale(v_permitted)::text,
      'stopDistance', trim_scale(v_distance)::text,
      'stopTicks', trim_scale(v_ticks)::text,
      'stopPips', case when i.pip_size is null then null
                       else trim_scale(div(v_distance * 100000000000000000000, i.pip_size) * 0.00000000000000000001)::text end,
      'plannedRR', trim_scale(v_rr)::text,
      'quantity', trim_scale(v_qty)::text,
      'nominalRisk', trim_scale(v_nominal)::text,
      'plannedReward', trim_scale(div(v_reward * 100000000000000000000, i.tick_size) * 0.00000000000000000001
                                  * i.tick_value * v_qty)::text);
    if v_risk_pct > r.max_risk_percent then
      v_issues := v_issues || private.risk_issue('RISK_LIMIT', 'BLOCK',
        'Requested risk ' || private.risk_padded(v_risk_pct) || '% exceeds your configured maximum of '
          || private.risk_padded(r.max_risk_percent) || '%.',
        jsonb_build_object('requested', trim_scale(v_risk_pct)::text, 'maximum', trim_scale(r.max_risk_percent)::text));
    end if;
    if v_qty < i.minimum_quantity then
      v_issues := v_issues || private.risk_issue('MINIMUM_QUANTITY', 'BLOCK',
        'Your ' || private.risk_money(v_budget, a.currency) || ' risk budget is too small for the minimum position size of '
          || trim_scale(i.minimum_quantity)::text || ' ' || i.quantity_unit || ' at this stop.',
        jsonb_build_object('budget', trim_scale(v_budget)::text, 'minQty', trim_scale(i.minimum_quantity)::text, 'unit', i.quantity_unit));
    end if;
    -- Cross multiplication: the verdict never depends on a rounded quotient.
    if v_reward < v_distance * r.min_rr then
      v_issues := v_issues || private.risk_issue('MIN_RR', r.rr_policy,
        case when r.rr_policy = 'BLOCK'
             then 'Planned RR ' || private.risk_padded(v_rr) || 'R is below the required minimum of ' || private.risk_padded(r.min_rr) || 'R.'
             else 'Planned RR ' || private.risk_padded(v_rr) || 'R is below your ' || private.risk_padded(r.min_rr)
                  || 'R minimum. Your risk plan allows it with a warning.' end,
        jsonb_build_object('rr', trim_scale(v_rr)::text, 'min', trim_scale(r.min_rr)::text));
    end if;
    if v_slots >= r.max_daily_trades then
      v_issues := v_issues || private.risk_issue('MAX_TRADES', 'BLOCK',
        'Daily trade limit reached: ' || v_slots || ' of ' || r.max_daily_trades || ' trades already used today ('
          || v_planned_slots || ' planned, ' || v_unplanned_trades || ' recorded live).',
        jsonb_build_object('used', v_slots, 'max', r.max_daily_trades, 'planned', v_planned_slots, 'unplanned', v_unplanned_trades));
    end if;
    if v_session = 'DEAD_POOL' then
      v_issues := v_issues || private.risk_issue('DEAD_POOL', 'BLOCK', v_dead_pool);
    elsif v_session <> 'ACTIVE_KILL_ZONE' then
      v_issues := v_issues || private.risk_issue('OUTSIDE_ACTIVE', 'WARN',
        'Outside the active kill zone (02:00' || v_dash || '12:00 UTC' || v_minus || '5).');
    end if;
    if p_duplicate then
      v_issues := v_issues || private.risk_issue('DUPLICATE', 'BLOCK',
        'An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today.');
    end if;
    if v_stale then
      v_issues := v_issues || private.risk_issue('STALE_EQUITY', 'BLOCK',
        'Confirm today''s account balance before locking (last recorded ' || to_char(o.trading_day, 'YYYY-MM-DD') || ').',
        jsonb_build_object('observationDay', to_char(o.trading_day, 'YYYY-MM-DD')));
    end if;
    if (p -> 'contradiction')::boolean then
      v_issues := v_issues || private.risk_issue('STRATEGY_CONTRADICTION', 'BLOCK',
        'Blocked because you flagged a contradiction with your ' || s.version || ' rules.', jsonb_build_object('strategy', s.version));
    end if;
    if p ->> 'news' = 'RESTRICTED' then
      v_issues := v_issues || private.risk_issue('NEWS_RESTRICTED', r.news_policy,
        'You reported a restricted news window. Your risk plan '
          || case when r.news_policy = 'BLOCK' then 'blocks' else 'warns about' end || ' trading in restricted news.');
    end if;
    if p ->> 'news' = 'UNKNOWN' then
      v_issues := v_issues || private.risk_issue('NEWS_UNKNOWN', 'WARN', 'Economic news has not been checked.');
    end if;
    if r.daily_risk_cap is null then
      v_issues := v_issues || private.risk_issue('DAILY_RISK_UNCONFIGURED', 'WARN', 'No daily risk cap is configured.');
    elsif v_risk_used + v_nominal > r.daily_risk_cap then
      v_remaining := greatest(r.daily_risk_cap - v_risk_used, 0);
      -- A nominal within the remaining risk only occurs for a zero-size trade once the reserved risk already exceeds
      -- the cap (e.g. after an immediate tightening): the sentence then names the reserved risk, as
      -- src/domain/risk-explain.ts renders it, instead of calling 0.00 insufficient for 0.00.
      v_issues := v_issues || private.risk_issue('DAILY_RISK_LIMIT', 'BLOCK',
        case when v_nominal <= v_remaining
             then 'Today''s reserved risk ' || private.risk_money(v_risk_used, a.currency) || ' plus this trade''s '
                  || private.risk_money(v_nominal, a.currency) || ' would exceed your daily risk cap of '
                  || private.risk_money(r.daily_risk_cap, a.currency) || '.'
             else 'Remaining daily risk ' || private.risk_money(v_remaining, a.currency) || ' is insufficient for this trade''s '
                  || private.risk_money(v_nominal, a.currency) || ' risk (cap ' || private.risk_money(r.daily_risk_cap, a.currency) || ').'
        end,
        jsonb_build_object('remaining', trim_scale(v_remaining)::text, 'nominal', trim_scale(v_nominal)::text,
          'cap', trim_scale(r.daily_risk_cap)::text, 'used', trim_scale(v_risk_used)::text));
    end if;
    if r.daily_loss_cap is null then
      v_issues := v_issues || private.risk_issue('DAILY_LOSS_UNCONFIGURED', 'WARN', 'No daily loss limit is configured.');
    elsif v_loss_total + v_open + v_nominal > r.daily_loss_cap then
      v_issues := v_issues || private.risk_issue('DAILY_LOSS_LIMIT', 'BLOCK',
        'Today''s realized losses ' || private.risk_money(v_loss_total, a.currency) || ' plus open risk '
          || private.risk_money(v_open, a.currency) || ' plus this trade''s ' || private.risk_money(v_nominal, a.currency)
          || ' would exceed your daily loss limit of ' || private.risk_money(r.daily_loss_cap, a.currency) || '.',
        jsonb_build_object('loss', trim_scale(v_loss_total)::text, 'open', trim_scale(v_open)::text,
          'nominal', trim_scale(v_nominal)::text, 'cap', trim_scale(r.daily_loss_cap)::text));
    end if;
    if v_unknown > 0 then
      v_issues := v_issues || private.risk_issue('UNPLANNED_RISK_UNKNOWN', 'WARN',
        case when v_unknown = 1 then '1 live-first trade without recorded risk is not included in the daily risk totals.'
             else v_unknown || ' live-first trades without recorded risk are not included in the daily risk totals.' end,
        jsonb_build_object('n', v_unknown));
    end if;
    v_issues := v_issues || private.risk_issue('COSTS_UNKNOWN', 'WARN',
      'Sizing uses the stop distance only; fees, gaps and slippage are not included.');
  end engine;

  -- Rule coverage parity (§6.3): evaluated even when sizing stopped early.
  if v_calc is null then
    if v_slots >= r.max_daily_trades then
      v_issues := v_issues || private.risk_issue('MAX_TRADES', 'BLOCK',
        'Daily trade limit reached: ' || v_slots || ' of ' || r.max_daily_trades || ' trades already used today ('
          || v_planned_slots || ' planned, ' || v_unplanned_trades || ' recorded live).',
        jsonb_build_object('used', v_slots, 'max', r.max_daily_trades, 'planned', v_planned_slots, 'unplanned', v_unplanned_trades));
    end if;
    if v_session = 'DEAD_POOL' then
      v_issues := v_issues || private.risk_issue('DEAD_POOL', 'BLOCK', v_dead_pool);
    end if;
    if v_stale then
      v_issues := v_issues || private.risk_issue('STALE_EQUITY', 'BLOCK',
        'Confirm today''s account balance before locking (last recorded ' || to_char(o.trading_day, 'YYYY-MM-DD') || ').',
        jsonb_build_object('observationDay', to_char(o.trading_day, 'YYYY-MM-DD')));
    end if;
  end if;

  return jsonb_build_object('engineVersion', '1.1', 'evaluatedAt', p_now, 'tradingDay', to_char(v_day, 'YYYY-MM-DD'),
    'session', v_session, 'strategyVersionId', s.id, 'riskPlanVersionId', r.id,
    'status', case when v_issues @> '[{"severity":"BLOCK"}]' then 'TRADE_BLOCKED' else 'RISK_APPROVED' end,
    'issues', v_issues, 'calculations', v_calc);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §6.4 Report 1.2: the core plus decision, all 18 rule results, self-describing limits and instrument, and the
-- usage snapshot (1.1 fields derived from the usage, plus every usage component).
-- ---------------------------------------------------------------------------------------------------------
create function private.risk_report_v12(p jsonb, a public.accounts, o public.account_observations,
  r public.risk_plan_versions, i public.instrument_versions, s public.strategy_versions, p_now timestamptz,
  p_usage jsonb, p_duplicate boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_core jsonb := private.evaluate_risk_v12(p, a, o, r, i, s, p_now, p_usage, p_duplicate);
  v_issues jsonb := v_core -> 'issues';
  v_rules text[] := array['INVALID_INPUT','INSTRUMENT_MISMATCH','CONTRACT_UNCONFIRMED','MISSING_STOP','PRICE_GEOMETRY',
    'OFF_TICK','RISK_LIMIT','SIZING_INVARIANT','MINIMUM_QUANTITY','MIN_RR','MAX_TRADES','DEAD_POOL','DUPLICATE',
    'STALE_EQUITY','STRATEGY_CONTRADICTION','NEWS_RESTRICTED','DAILY_RISK_LIMIT','DAILY_LOSS_LIMIT'];
  v_parsed boolean := not (v_issues @> '[{"code":"INVALID_INPUT"}]');
  v_stop_known boolean;
  v_geometry_ok boolean;
  v_sized boolean := jsonb_typeof(v_core -> 'calculations') = 'object';
  v_blocked boolean := v_issues @> '[{"severity":"BLOCK"}]';
  v_results jsonb := '[]';
  v_rule text; v_found jsonb; v_evaluated boolean; v_requested text; v_target_distance text;
  v_planned_risk numeric := (p_usage ->> 'plannedRisk')::numeric;
  v_unplanned_risk numeric := (p_usage ->> 'unplannedRisk')::numeric;
begin
  v_stop_known := v_parsed and jsonb_typeof(p -> 'stop') = 'string';
  v_geometry_ok := v_stop_known and not (v_issues @> '[{"code":"PRICE_GEOMETRY"}]');
  foreach v_rule in array v_rules loop
    select x.value into v_found from jsonb_array_elements(v_issues) with ordinality as x(value, position)
     where x.value ->> 'code' = v_rule order by x.position limit 1;
    if v_found is not null then
      v_results := v_results || jsonb_build_array(jsonb_build_object('rule', v_rule, 'outcome', v_found ->> 'severity',
        'message', v_found ->> 'message'));
    else
      v_evaluated := case v_rule
        when 'INVALID_INPUT' then true when 'MAX_TRADES' then true when 'DEAD_POOL' then true when 'STALE_EQUITY' then true
        when 'INSTRUMENT_MISMATCH' then v_parsed when 'CONTRACT_UNCONFIRMED' then v_parsed when 'MISSING_STOP' then v_parsed
        when 'PRICE_GEOMETRY' then v_stop_known
        when 'OFF_TICK' then v_geometry_ok when 'SIZING_INVARIANT' then v_geometry_ok
        when 'NEWS_RESTRICTED' then v_sized and p ->> 'news' <> 'UNKNOWN'
        when 'DAILY_RISK_LIMIT' then v_sized and r.daily_risk_cap is not null
        when 'DAILY_LOSS_LIMIT' then v_sized and r.daily_loss_cap is not null
        else v_sized end;
      v_results := v_results || jsonb_build_array(jsonb_build_object('rule', v_rule,
        'outcome', case when v_evaluated then 'PASS' else 'NOT_EVALUATED' end,
        'message', case when not v_evaluated then 'Not evaluated.'
                        when v_rule = 'STRATEGY_CONTRADICTION' then 'No contradiction reported; qualitative setup is not evaluated.'
                        else 'Check passed.' end));
    end if;
  end loop;
  -- Casts run only for a validated proposal.
  if v_parsed then
    v_requested := trim_scale((p ->> 'riskPercent')::numeric)::text;
    if v_sized then v_target_distance := trim_scale(abs((p ->> 'target')::numeric - (p ->> 'entry')::numeric))::text; end if;
  end if;
  return jsonb_build_object(
    'engineVersion', '1.1', 'reportVersion', '1.2',
    'evaluatedAt', p_now, 'tradingDay', v_core ->> 'tradingDay', 'session', v_core ->> 'session',
    'strategyVersionId', s.id, 'riskPlanVersionId', r.id,
    'decision', case when v_blocked then 'BLOCKED' else 'APPROVED' end,
    'status', case when v_blocked then 'TRADE_BLOCKED' else 'RISK_APPROVED' end,
    'issues', v_issues, 'ruleResults', v_results,
    'requestedRiskPercent', v_requested, 'targetDistance', v_target_distance,
    'sessionEligible', (v_core ->> 'session') <> 'DEAD_POOL',
    'calculations', v_core -> 'calculations',
    'limits', jsonb_build_object(
      'maxRiskPercent', trim_scale(r.max_risk_percent)::text, 'defaultRiskPercent', trim_scale(r.default_risk_percent)::text,
      'minRR', trim_scale(r.min_rr)::text, 'rrPolicy', r.rr_policy, 'newsPolicy', r.news_policy,
      'maxDailyTrades', r.max_daily_trades, 'dailyRiskCap', trim_scale(r.daily_risk_cap)::text,
      'dailyLossCap', trim_scale(r.daily_loss_cap)::text, 'riskPlanVersion', r.version),
    'instrument', jsonb_build_object(
      'symbol', i.symbol, 'currency', i.currency, 'tickSize', trim_scale(i.tick_size)::text,
      'pipSize', trim_scale(i.pip_size)::text, 'tickValue', trim_scale(i.tick_value)::text,
      'quantityStep', trim_scale(i.quantity_step)::text, 'minimumQuantity', trim_scale(i.minimum_quantity)::text,
      'quantityUnit', i.quantity_unit),
    'snapshot', jsonb_build_object(
      'accountObservationId', o.id, 'observationDay', to_char(o.trading_day, 'YYYY-MM-DD'),
      'equity', trim_scale(o.equity)::text, 'currency', a.currency, 'instrumentVersionId', i.id,
      'slotsUsed', (p_usage ->> 'plannedSlots')::int + (p_usage ->> 'unplannedTrades')::int,
      'executedTrades', (p_usage ->> 'unplannedTrades')::int, 'maximumDailyTrades', r.max_daily_trades,
      'riskConsumed', trim_scale(v_planned_risk + v_unplanned_risk)::text,
      'grossLoss', trim_scale((p_usage ->> 'lossTotal')::numeric)::text,
      'plannedSlots', (p_usage ->> 'plannedSlots')::int, 'unplannedTrades', (p_usage ->> 'unplannedTrades')::int,
      'plannedRisk', trim_scale(v_planned_risk)::text, 'unplannedRisk', trim_scale(v_unplanned_risk)::text,
      'unplannedRiskUnknown', (p_usage ->> 'unplannedRiskUnknown')::int,
      'realizedLoss', trim_scale((p_usage ->> 'realizedLoss')::numeric)::text,
      'externalLoss', trim_scale((p_usage ->> 'externalLoss')::numeric)::text,
      'legacyReportedLoss', trim_scale((p_usage ->> 'legacyReportedLoss')::numeric)::text,
      'openExposure', trim_scale((p_usage ->> 'openExposure')::numeric)::text,
      'openRiskUnknown', (p_usage ->> 'openRiskUnknown')::int,
      'riskUnknownTrades', (p_usage ->> 'riskUnknownTrades')::int));
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Every engine path evaluates with report 1.2, private.active_risk_plan and private.daily_usage. Signatures,
-- envelopes, errors, persistence and locking are unchanged (0003 assess_plan, 0015 check_proposal_risk), except that
-- p_lock must be true or false: with NULL every lock branch below was skipped while the final test still fell through
-- to the plan insert, a lock outside every caller's checks.
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.assess_plan(p_account_id uuid,p_proposal jsonb,p_key uuid,p_expected_risk_id uuid,p_expected_observation_id uuid,p_lock boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.accounts; o public.account_observations; r public.risk_plan_versions; i public.instrument_versions; s public.strategy_versions;
  existing public.trade_plans; new_plan public.trade_plans; v_now timestamptz; v_usage jsonb; duplicate boolean; result jsonb; evaluation_id uuid;
begin
  if p_lock is null then raise exception 'INVALID_INPUT: p_lock must be true or false'; end if;
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_lock and p_key is null then raise exception 'Lock request key required'; end if;
  select * into a from public.accounts where id=p_account_id and user_id=auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  if p_lock then
    select * into existing from public.trade_plans where account_id=a.id and idempotency_key=p_key;
    if found then
      if existing.proposal is distinct from p_proposal then raise exception 'Idempotency key already used for different input'; end if;
      return jsonb_build_object('planId',existing.id,'evaluationId',existing.risk_evaluation_id,'result',existing.risk_result,'replayed',true);
    end if;
  end if;
  v_now:=clock_timestamp();
  select * into r from private.active_risk_plan(a.id,private.strategy_day(v_now));
  select * into o from public.account_observations where account_id=a.id order by recorded_at desc,id desc limit 1;
  select * into s from public.strategy_versions where account_id=a.id and version='ICT V1.0';
  select * into i from public.instrument_versions where account_id=a.id and id=(p_proposal->>'instrumentId')::uuid;
  if r.id is null or o.id is null or s.id is null or i.id is null then raise exception 'Account configuration is incomplete'; end if;
  if r.id is distinct from p_expected_risk_id or o.id is distinct from p_expected_observation_id then raise exception 'Account or risk plan changed. Refresh and recheck.'; end if;
  v_usage:=private.daily_usage(a.id,v_now,null);
  -- Numeric casts run only for lexically valid price strings; malformed requests remain blocked reports.
  duplicate:=false;
  if p_proposal->>'entry' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' and p_proposal->>'stop' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' and p_proposal->>'target' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then
    select exists(select 1 from public.trade_plans where account_id=a.id and trading_day=private.strategy_day(v_now)
      and (proposal->>'instrumentId')::uuid=i.id and proposal->>'direction'=p_proposal->>'direction' and proposal->>'model'=p_proposal->>'model'
      and (proposal->>'entry')::numeric=(p_proposal->>'entry')::numeric and (proposal->>'stop')::numeric=(p_proposal->>'stop')::numeric and (proposal->>'target')::numeric=(p_proposal->>'target')::numeric) into duplicate;
  end if;
  result:=private.risk_report_v12(p_proposal,a,o,r,i,s,v_now,v_usage,duplicate);
  insert into public.risk_evaluations(user_id,account_id,proposal,result,account_observation_id,strategy_version_id,risk_plan_version_id,instrument_version_id,source)
    values(a.user_id,a.id,p_proposal,result,o.id,s.id,r.id,i.id,case when p_lock then 'LOCK_RECHECK' else 'EXPLICIT_CHECK' end) returning id into evaluation_id;
  if not p_lock or result->>'decision'='BLOCKED' then return jsonb_build_object('planId',null,'evaluationId',evaluation_id,'result',result,'replayed',false); end if;
  insert into public.trade_plans(user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at)
    values(a.user_id,a.id,s.id,r.id,i.id,o.id,evaluation_id,p_key,p_proposal,result,(result#>>'{calculations,nominalRisk}')::numeric,private.strategy_day(v_now),v_now) returning * into new_plan;
  insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at)
    values(a.user_id,a.id,new_plan.id,'PLAN_LOCKED',jsonb_build_object('risk_evaluation_id',evaluation_id,'setup_status','NOT_EVALUATED','actor',a.user_id,'source','USER_COMMAND'),v_now);
  return jsonb_build_object('planId',new_plan.id,'evaluationId',evaluation_id,'result',result,'replayed',false);
end $$;

create or replace function private.check_proposal_risk(p_proposal_id uuid, p_lock boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.setup_proposals; r uuid; o uuid; result jsonb; linked uuid;
 a public.accounts; obs public.account_observations; rp public.risk_plan_versions; inst public.instrument_versions; s public.strategy_versions;
 now_at timestamptz; v_usage jsonb; duplicate boolean; report jsonb; rid uuid;
begin
 if p_lock is null then raise exception 'INVALID_INPUT: p_lock must be true or false'; end if;
 select * into v from public.setup_proposals where id=p_proposal_id and user_id=auth.uid();
 if not found then raise exception 'Proposal not found'; end if;
 perform 1 from public.accounts where id=v.account_id for update;
 select plan_id into linked from public.setup_locks where proposal_id=v.id;
 if linked is not null then
   if not p_lock then
     now_at:=clock_timestamp();
     select * into a from public.accounts where id=v.account_id;
     select * into obs from public.account_observations where account_id=v.account_id order by recorded_at desc,id desc limit 1;
     select * into rp from private.active_risk_plan(v.account_id,private.strategy_day(now_at));
     select * into inst from public.instrument_versions where id=v.instrument_version_id;
     select * into s from public.strategy_versions where id=v.strategy_version_id and version='ICT V1.0';
     if s.id is null then raise exception 'Attached strategy is not supported by this risk engine'; end if;
     -- Recheck a reserved plan without double-counting its own reservation.
     v_usage:=private.daily_usage(v.account_id,now_at,linked);
     select exists(select 1 from public.trade_plans p where p.account_id=v.account_id and p.trading_day=private.strategy_day(now_at) and p.id<>linked
       and p.instrument_version_id=v.instrument_version_id and p.proposal->>'direction'=v.proposal->>'direction' and p.proposal->>'model'=v.proposal->>'model'
       and (p.proposal->>'entry')::numeric=(v.proposal->>'entry')::numeric and (p.proposal->>'stop')::numeric=(v.proposal->>'stop')::numeric and (p.proposal->>'target')::numeric=(v.proposal->>'target')::numeric) into duplicate;
     report:=private.risk_report_v12(v.proposal,a,obs,rp,inst,s,now_at,v_usage,duplicate);
     insert into public.risk_evaluations(user_id,account_id,proposal,result,account_observation_id,strategy_version_id,risk_plan_version_id,instrument_version_id,source)
       values(v.user_id,v.account_id,v.proposal,report,obs.id,v.strategy_version_id,rp.id,inst.id,'EXPLICIT_CHECK') returning id into rid;
     insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,rid);
     return jsonb_build_object('planId',linked,'evaluationId',rid,'result',report,'replayed',false);
   end if;
   select jsonb_build_object('planId',id,'evaluationId',risk_evaluation_id,'result',risk_result,'replayed',true) into result from public.trade_plans where id=linked;
   return result;
 end if;
 r:=(private.active_risk_plan(v.account_id,private.strategy_day(clock_timestamp()))).id;
 select id into o from public.account_observations where account_id=v.account_id order by recorded_at desc,id desc limit 1;
 result:=private.assess_plan(v.account_id,v.proposal,v.id,r,o,p_lock);
 -- Current deterministic engine supports ICT V1.0 only. Never retarget a future attached strategy.
 if (result#>>'{result,strategyVersionId}')::uuid<>v.strategy_version_id then raise exception 'Attached strategy is not supported by this risk engine'; end if;
 insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,(result->>'evaluationId')::uuid);
 if result->>'planId' is not null then
   insert into public.setup_locks(user_id,account_id,proposal_id,plan_id) values(v.user_id,v.account_id,v.id,(result->>'planId')::uuid);
 end if;
 return result;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §6.2 Daily usage for the TS preview and Today (owner only, database clock).
-- ---------------------------------------------------------------------------------------------------------
create function public.get_daily_risk_usage(p_account_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  if not exists (select 1 from public.accounts a where a.id = p_account_id and a.user_id = auth.uid()) then
    raise exception 'ACCOUNT_NOT_FOUND: Account not found';
  end if;
  return private.daily_usage(p_account_id, clock_timestamp(), null);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Function privileges: explicit revoke per signature, then the exact grant.
-- ---------------------------------------------------------------------------------------------------------
revoke all on function
  private.daily_usage(uuid, timestamptz, uuid), private.risk_padded(numeric), private.risk_money(numeric, text),
  private.risk_issue(text, text, text, jsonb), private.risk_positive_price(jsonb), private.risk_invalid_fields(jsonb),
  private.evaluate_risk_v12(jsonb, public.accounts, public.account_observations, public.risk_plan_versions,
    public.instrument_versions, public.strategy_versions, timestamptz, jsonb, boolean),
  private.risk_report_v12(jsonb, public.accounts, public.account_observations, public.risk_plan_versions,
    public.instrument_versions, public.strategy_versions, timestamptz, jsonb, boolean),
  private.assess_plan(uuid, jsonb, uuid, uuid, uuid, boolean), private.check_proposal_risk(uuid, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.get_daily_risk_usage(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_daily_risk_usage(uuid) to authenticated;

notify pgrst, 'reload schema';
