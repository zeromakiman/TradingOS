-- Trading OS V2: platform connections (docs/V2_ARCHITECTURE.md §8.6, §10.3, §0.5).
-- Connection-ready and read-only by construction; V2 accepts only the MOCK provider. External executions are
-- platform positions deduplicated by (connection_id, external_id), and the stored version is never overwritten:
--   * an identical payload is a no-op;
--   * a position first seen open and later seen closed, with its identity (symbol, direction, volume, entry price,
--     entry time) unchanged, gets its close appended once to external_execution_closes; for an IMPORTED trade
--     created from it, the trade's unplanned close is appended as well (pnl_source IMPORTED);
--   * any other changed payload is recorded once as a WARNING connection event.
-- Ingest and sync status are service-only (trusted server; the user id comes from the verified session and is
-- re-checked here). Links between trades and executions are append-only LINK/UNLINK rows; the latest row of an
-- execution (or of a trade) is its link state. Errors start with a stable code prefix ('CONNECTION_EXISTS: ...').

-- ---------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------
-- One connection per trading account and provider: connecting again after a disconnect resumes the same
-- connection, so positions that were already imported are never imported twice.
create table public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  provider text not null check (provider in ('CTRADER','MT5','MOCK')),
  label text not null check (length(label) between 1 and 60 and label = btrim(label)),
  -- Masked display reference of the platform account (for example '••••4821'); never a secret.
  external_account_ref text check (external_account_ref is null or length(btrim(external_account_ref)) between 1 and 40),
  created_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  unique (user_id, request_key),
  unique (user_id, account_id, id),
  unique (account_id, provider),
  foreign key (user_id, account_id) references public.accounts(user_id, id),
  constraint platform_connections_finite check (isfinite(created_at))
);

-- The first version of a platform position (ExternalPosition of src/domain/sync/contract.ts). realized_pnl is the
-- platform's net realized P&L (after commission and swap); commission and swap are signed (negative = cost).
create table public.external_executions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  connection_id uuid not null,
  external_id text not null check (length(external_id) between 1 and 120 and external_id = btrim(external_id) and external_id !~ '[[:cntrl:]]'),
  symbol text not null check (symbol ~ '^[A-Z0-9][A-Z0-9._/-]{0,19}$'),
  direction text not null check (direction in ('LONG','SHORT')),
  volume numeric not null check (volume > 0),
  entry_price numeric not null check (entry_price > 0),
  entered_at timestamptz not null,
  exit_price numeric check (exit_price > 0),
  exited_at timestamptz,
  commission numeric(20,2),
  swap numeric(20,2),
  realized_pnl numeric(20,2),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default clock_timestamp(),
  unique (connection_id, external_id),
  unique (connection_id, id),
  unique (user_id, account_id, id),
  foreign key (user_id, account_id, connection_id) references public.platform_connections(user_id, account_id, id),
  check (exit_price is null or exited_at is not null),
  check (exited_at is null or exited_at >= entered_at),
  check (exited_at is null or exit_price is not null or realized_pnl is not null),
  constraint external_executions_finite check (
    volume not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and entry_price not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and exit_price not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and commission <> 'NaN'::numeric
    and swap <> 'NaN'::numeric
    and realized_pnl <> 'NaN'::numeric
    and isfinite(entered_at)
    and (exited_at is null or isfinite(exited_at))
    and isfinite(received_at))
);
create index external_executions_account on public.external_executions(account_id, entered_at desc, id);

-- The platform close of a position that was first stored open (at most one per execution). payload_hash is the
-- hash of the closed payload, so receiving that payload again is a no-op.
create table public.external_execution_closes (
  external_execution_id uuid primary key,
  user_id uuid not null,
  account_id uuid not null,
  exit_price numeric check (exit_price > 0),
  exited_at timestamptz not null,
  commission numeric(20,2),
  swap numeric(20,2),
  realized_pnl numeric(20,2),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  check (exit_price is not null or realized_pnl is not null),
  constraint external_execution_closes_finite check (
    exit_price not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and commission <> 'NaN'::numeric
    and swap <> 'NaN'::numeric
    and realized_pnl <> 'NaN'::numeric
    and isfinite(exited_at)
    and isfinite(recorded_at)),
  foreign key (user_id, account_id, external_execution_id) references public.external_executions(user_id, account_id, id)
);

-- Connection state history; the newest event that is not a WARNING is the current state. A WARNING never
-- changes the state: it records a changed or unusable platform payload of one execution, once per payload.
create table public.platform_connection_events (
  id bigint generated always as identity primary key,
  connection_id uuid not null,
  user_id uuid not null,
  account_id uuid not null,
  status text not null check (status in ('PENDING','CONNECTED','SYNCING','SYNCED','ERROR','DISCONNECTED','WARNING')),
  message text check (message is null or (length(message) between 1 and 300 and message = btrim(message))),
  synced_through timestamptz,
  external_execution_id uuid,
  payload_hash text check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  check (synced_through is null or status = 'SYNCED'),
  check (status not in ('ERROR','WARNING') or message is not null),
  check ((status = 'WARNING') = (external_execution_id is not null)),
  check ((external_execution_id is null) = (payload_hash is null)),
  constraint platform_connection_events_finite check ((synced_through is null or isfinite(synced_through)) and isfinite(recorded_at)),
  foreign key (user_id, account_id, connection_id) references public.platform_connections(user_id, account_id, id),
  foreign key (connection_id, external_execution_id) references public.external_executions(connection_id, id)
);
create index platform_connection_events_latest on public.platform_connection_events(connection_id, id desc);
create unique index platform_connection_events_warning on public.platform_connection_events(external_execution_id, payload_hash)
  where external_execution_id is not null;

-- The composite keys force the trade and the execution into the same trading account.
create table public.trade_execution_links (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  external_execution_id uuid not null,
  action text not null check (action in ('LINK','UNLINK')),
  method text not null check (method in ('AUTO_MATCH','USER','IMPORT_CREATED')),
  recorded_at timestamptz not null default clock_timestamp(),
  -- Only the trader removes a link; links that created an imported trade are never removed.
  constraint trade_execution_links_unlink_by_user check (action = 'LINK' or method = 'USER'),
  constraint trade_execution_links_finite check (isfinite(recorded_at)),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, external_execution_id) references public.external_executions(user_id, account_id, id)
);
create index trade_execution_links_trade on public.trade_execution_links(trade_id, id desc);
create index trade_execution_links_execution on public.trade_execution_links(external_execution_id, id desc);

-- Sealed provider credentials for future read-only providers. No grants; unused in V2.
create table private.platform_connection_secrets (
  connection_id uuid primary key references public.platform_connections(id) on delete cascade,
  sealed bytea not null,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on private.platform_connection_secrets from public, anon, authenticated, service_role;

-- §0.5 Every new table: RLS, a single owner read policy, no direct writes for any API role, immutability.
-- The TRUNCATE guard for every public table is installed by 0019_account_erasure.sql.
do $$
declare t text;
begin
  foreach t in array array['platform_connections','external_executions','external_execution_closes',
    'platform_connection_events','trade_execution_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy read_own on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create trigger immutable_record before update or delete on public.%I for each row execute function private.reject_mutation()', t);
  end loop;
end $$;
revoke all on sequence public.platform_connection_events_id_seq, public.trade_execution_links_id_seq
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Private helpers (never executable by API roles; called from security-definer RPCs and triggers).
-- ---------------------------------------------------------------------------------------------------------
create function private.connection_status(p_connection_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select e.status from public.platform_connection_events e
   where e.connection_id = p_connection_id and e.status <> 'WARNING'
   order by e.id desc limit 1
$$;

-- Link state: the latest row of an execution (or of a trade) is LINK while it is linked. A LINK requires both
-- sides to be unlinked and an UNLINK targets the active pair, so the latest row always describes the pair.
create function private.active_execution_link(p_execution_id uuid) returns public.trade_execution_links
language sql stable security definer set search_path = '' as $$
  select l.* from (select * from public.trade_execution_links where external_execution_id = p_execution_id order by id desc limit 1) l
   where l.action = 'LINK'
$$;

create function private.active_trade_link(p_trade_id uuid) returns public.trade_execution_links
language sql stable security definer set search_path = '' as $$
  select l.* from (select * from public.trade_execution_links where trade_id = p_trade_id order by id desc limit 1) l
   where l.action = 'LINK'
$$;

-- Mirrors normalizeSymbol (src/domain/sync/normalize.ts): upper case without spaces or '/'.
create function private.normalized_symbol(p_symbol text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(btrim(p_symbol), '[[:space:]/]+', '', 'g'))
$$;

-- sha256 (hex) of the canonical position, identical to positionHash (src/domain/sync/normalize.ts):
-- JSON.stringify of [externalId, symbol, direction, volume, entryPrice, enteredAt, exitPrice, exitedAt,
-- commission, swap, realizedPnl, currency] with canonical decimals and YYYY-MM-DDTHH:MM:SS.ffffffZ instants.
create function private.external_execution_hash(x public.external_executions) returns text
language sql stable set search_path = '' as $$
  select encode(sha256(convert_to('[' || array_to_string(array[
      to_json(x.external_id)::text,
      to_json(x.symbol)::text,
      to_json(x.direction)::text,
      to_json(trim_scale(x.volume)::text)::text,
      to_json(trim_scale(x.entry_price)::text)::text,
      to_json(to_char(x.entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
      coalesce(to_json(trim_scale(x.exit_price)::text)::text, 'null'),
      coalesce(to_json(to_char(x.exited_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, 'null'),
      coalesce(to_json(trim_scale(x.commission)::text)::text, 'null'),
      coalesce(to_json(trim_scale(x.swap)::text)::text, 'null'),
      coalesce(to_json(trim_scale(x.realized_pnl)::text)::text, 'null'),
      to_json(x.currency)::text
    ], ',') || ']', 'UTF8')), 'hex')
$$;

-- Validates one platform position (the normalized ExternalPosition of src/domain/sync/contract.ts) and returns
-- it as an unsaved row with the payload hash computed here; a supplied payloadHash must match it.
create function private.external_execution_input(p_currency text, p_execution jsonb) returns public.external_executions
language plpgsql security definer set search_path = '' as $$
declare x public.external_executions; v_now timestamptz := clock_timestamp(); v_given text;
begin
  perform private.require_object(p_execution, array['externalId','symbol','direction','volume','entryPrice','enteredAt',
    'exitPrice','exitedAt','commission','swap','realizedPnl','currency','payloadHash'], 'execution');
  x.external_id := private.json_text(p_execution, 'externalId');
  if x.external_id is null or length(x.external_id) not between 1 and 120 or x.external_id <> btrim(x.external_id)
     or x.external_id ~ '[[:cntrl:]]' then
    raise exception 'INVALID_INPUT: externalId must contain 1 to 120 printable characters without surrounding spaces';
  end if;
  x.symbol := private.json_text(p_execution, 'symbol');
  if x.symbol is null or x.symbol !~ '^[A-Z0-9][A-Z0-9._/-]{0,19}$' then
    raise exception 'INVALID_INPUT: symbol must be 1 to 20 characters of A-Z, 0-9, ".", "_", "/" or "-"';
  end if;
  x.direction := private.json_text(p_execution, 'direction');
  if x.direction is null or x.direction not in ('LONG','SHORT') then
    raise exception 'INVALID_INPUT: direction must be LONG or SHORT';
  end if;
  x.volume := private.decimal_input(private.json_text(p_execution, 'volume'), 'volume');
  x.entry_price := private.decimal_input(private.json_text(p_execution, 'entryPrice'), 'entryPrice');
  x.entered_at := private.instant_input(private.json_text(p_execution, 'enteredAt'), 'enteredAt');
  if x.volume is null or x.entry_price is null or x.entered_at is null then
    raise exception 'INVALID_INPUT: volume, entryPrice and enteredAt are required';
  end if;
  x.exit_price := private.decimal_input(private.json_text(p_execution, 'exitPrice'), 'exitPrice');
  x.exited_at := private.instant_input(private.json_text(p_execution, 'exitedAt'), 'exitedAt');
  x.commission := private.signed_money_input(private.json_text(p_execution, 'commission'), 'commission');
  x.swap := private.signed_money_input(private.json_text(p_execution, 'swap'), 'swap');
  x.realized_pnl := private.signed_money_input(private.json_text(p_execution, 'realizedPnl'), 'realizedPnl');
  x.currency := private.json_text(p_execution, 'currency');
  if x.currency is null or x.currency !~ '^[A-Z]{3}$' then
    raise exception 'INVALID_INPUT: currency must be a three-letter code';
  end if;
  if x.currency <> p_currency then
    raise exception 'CURRENCY_MISMATCH: The execution is in % but the trading account uses %', x.currency, p_currency;
  end if;
  if x.exit_price is not null and x.exited_at is null then
    raise exception 'INVALID_INPUT: exitPrice requires exitedAt';
  end if;
  if x.exited_at is not null and x.exit_price is null and x.realized_pnl is null then
    raise exception 'INVALID_INPUT: A closed position needs exitPrice or realizedPnl';
  end if;
  if x.entered_at > v_now or x.exited_at > v_now then
    raise exception 'INVALID_TIME: Platform times must not be in the future';
  end if;
  if x.exited_at < x.entered_at then
    raise exception 'INVALID_TIME: The exit time is before the entry time';
  end if;
  x.payload_hash := private.external_execution_hash(x);
  v_given := private.json_text(p_execution, 'payloadHash');
  if v_given is not null and v_given <> x.payload_hash then
    raise exception 'INVALID_INPUT: payloadHash does not match the execution';
  end if;
  return x;
end $$;

-- 'EURUSD long position MOCK-1001': the subject of every warning message (the platform's ticket, no internal ids).
create function private.execution_label(p_execution public.external_executions) returns text
language sql stable set search_path = '' as $$
  select format('%s %s position %s', p_execution.symbol, lower(p_execution.direction), p_execution.external_id)
$$;

-- Records a WARNING for one payload of an execution; the same payload never warns twice.
create function private.execution_warning(p_execution public.external_executions, p_payload_hash text, p_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.platform_connection_events(connection_id, user_id, account_id, status, message, external_execution_id, payload_hash)
    values (p_execution.connection_id, p_execution.user_id, p_execution.account_id, 'WARNING',
            private.execution_label(p_execution) || ' ' || p_message, p_execution.id, p_payload_hash)
    on conflict (external_execution_id, payload_hash) where external_execution_id is not null do nothing;
end $$;

-- UNPLANNED_CLOSE_V1 for an imported position: net P&L is the platform's realized P&L (pnl_source IMPORTED).
-- Fees are the platform's net costs (commission and swap are signed, negative = cost); when the platform reports
-- no cost at all, or a net credit, the gross/fee split is unknown and gross stays null. The risk basis is derived
-- exactly as close_live_trade does (a reported risk amount, else the stop distance with a known contract), so
-- realized R exists only when the trader recorded what was at risk.
create function private.close_imported_trade(p_trade public.trades, p_exit_price numeric, p_exited_at timestamptz,
  p_commission numeric, p_swap numeric, p_realized_pnl numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pos public.trade_position_facts; i public.instrument_versions; v_net numeric := trim_scale(p_realized_pnl);
  v_costs numeric := -(coalesce(p_commission, 0) + coalesce(p_swap, 0)); v_gross numeric; v_basis numeric;
  v_basis_source text; v_r numeric;
begin
  if (p_commission is not null or p_swap is not null) and v_costs >= 0 then
    v_gross := trim_scale(v_net + v_costs);
  end if;
  pos := private.effective_position(p_trade.id);
  select * into i from public.instrument_versions where id = pos.instrument_version_id;
  if pos.risk_amount is not null then
    v_basis := trim_scale(pos.risk_amount);
    v_basis_source := 'USER_REPORTED';
  elsif i.id is not null and pos.entry_price is not null and pos.initial_stop is not null and pos.quantity is not null then
    v_basis := trim_scale(abs(pos.entry_price - pos.initial_stop) * i.tick_value * pos.quantity / i.tick_size);
    v_basis_source := 'DERIVED';
  end if;
  if v_basis is not null then v_r := trim_scale(v_net / v_basis); end if;
  insert into public.trade_unplanned_closes(trade_id, user_id, account_id, exit_price, exited_at, fees, gross_pnl, net_pnl,
      pnl_source, risk_basis, risk_basis_source, realized_r, outcome)
    values (p_trade.id, p_trade.user_id, p_trade.account_id, p_exit_price, p_exited_at, trim_scale(greatest(v_costs, 0)), v_gross,
      v_net, 'IMPORTED', v_basis, v_basis_source, v_r,
      case when v_net > 0 then 'WIN' when v_net < 0 then 'LOSS' else 'BREAKEVEN' end);
end $$;

-- Rules every link must satisfy (§8.6): same trading account, a planned trade in one of the allowed lifecycle
-- states, the same instrument (normalized symbol) and direction, executed at or after the plan lock, and neither
-- side linked already. The trade and execution rows are locked by the caller.
create function private.check_execution_link(p_trade public.trades, p_execution public.external_executions, p_lifecycles text[])
returns void
language plpgsql stable security definer set search_path = '' as $$
declare l record;
begin
  if p_trade.account_id <> p_execution.account_id then
    raise exception 'LINK_MISMATCH: The trade belongs to another trading account';
  end if;
  select t.origin, t.lifecycle, t.symbol, t.direction, t.locked_at into l from public.trade_ledger t where t.id = p_trade.id;
  if l.origin <> 'PLANNED' then
    raise exception 'LINK_NOT_ALLOWED: Only planned trades can be linked to a platform execution';
  end if;
  if not (l.lifecycle = any (p_lifecycles)) then
    raise exception 'LINK_NOT_ALLOWED: A % trade cannot be linked to a platform execution', lower(l.lifecycle);
  end if;
  if private.normalized_symbol(l.symbol) is distinct from private.normalized_symbol(p_execution.symbol) then
    raise exception 'LINK_MISMATCH: The execution is for % but the trade is for %', p_execution.symbol, coalesce(l.symbol, 'another instrument');
  end if;
  if l.direction is distinct from p_execution.direction then
    raise exception 'LINK_MISMATCH: The execution is % but the trade is %', lower(p_execution.direction), lower(coalesce(l.direction, 'unknown'));
  end if;
  if l.locked_at is null or p_execution.entered_at < l.locked_at then
    raise exception 'LINK_MISMATCH: The execution was entered before the plan was locked';
  end if;
  if (private.active_trade_link(p_trade.id)).id is not null then
    raise exception 'TRADE_ALREADY_LINKED: The trade is already linked to a platform execution';
  end if;
  if (private.active_execution_link(p_execution.id)).id is not null then
    raise exception 'EXECUTION_ALREADY_LINKED: The platform execution is already linked to a trade';
  end if;
end $$;

-- Backstop for every writer: a LINK needs both sides unlinked (imported trades only through IMPORT_CREATED,
-- planned trades only through AUTO_MATCH or USER, live-first trades never); an UNLINK must target the active
-- pair and never the link that created an imported trade.
create function private.guard_execution_links() returns trigger
language plpgsql set search_path = '' as $$
declare v_origin text; current_link public.trade_execution_links;
begin
  select t.origin into v_origin from public.trades t where t.id = new.trade_id;
  current_link := private.active_execution_link(new.external_execution_id);
  if new.action = 'LINK' then
    if v_origin = 'LIVE_FIRST' or (v_origin = 'IMPORTED') <> (new.method = 'IMPORT_CREATED') then
      raise exception 'LINK_NOT_ALLOWED: This trade cannot be linked with method %', new.method;
    end if;
    if current_link.id is not null then
      raise exception 'EXECUTION_ALREADY_LINKED: The platform execution is already linked to a trade';
    end if;
    if (private.active_trade_link(new.trade_id)).id is not null then
      raise exception 'TRADE_ALREADY_LINKED: The trade is already linked to a platform execution';
    end if;
  else
    if current_link.id is null or current_link.trade_id <> new.trade_id then
      raise exception 'LINK_NOT_FOUND: The trade and the platform execution are not linked';
    end if;
    if current_link.method = 'IMPORT_CREATED' then
      raise exception 'LINK_NOT_REMOVABLE: An imported trade stays linked to the platform position it was created from';
    end if;
  end if;
  return new;
end $$;
create trigger execution_links_guard before insert on public.trade_execution_links
  for each row execute function private.guard_execution_links();

-- A plan with a linked platform position is never skipped or cancelled: the position's result would then count in no
-- result and no daily limit (V2_1_GAPS.md §1.2). Linking already refuses a skipped or cancelled plan (its lifecycle);
-- this covers the other order, for every writer of trade_dispositions (set_planned_disposition and the V1 RPC).
create function private.guard_linked_disposition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.trade_plan_links pl
              where pl.plan_id = new.plan_id and (private.active_trade_link(pl.trade_id)).id is not null) then
    raise exception 'EXECUTION_LINKED: A platform position is linked to this plan; unlink it before marking the plan skipped or cancelled';
  end if;
  return new;
end $$;
create trigger linked_disposition_guard before insert on public.trade_dispositions
  for each row execute function private.guard_linked_disposition();

create function private.link_envelope(p_link public.trade_execution_links, p_replayed boolean) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('linkId', p_link.id, 'tradeId', p_link.trade_id, 'executionId', p_link.external_execution_id,
                            'accountId', p_link.account_id, 'action', p_link.action, 'method', p_link.method,
                            'recordedAt', p_link.recorded_at, 'replayed', p_replayed)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Connections (authenticated). Only MOCK is available in V2; the server offers it in developer mode only.
-- ---------------------------------------------------------------------------------------------------------
-- Returns the connection id. A replay of the request key returns the same id; connecting an account whose
-- connection to this provider exists resumes it (a CONNECTED event when it was disconnected). A trading account
-- has at most one active connection.
create function public.create_platform_connection(p_account_id uuid, p_provider text, p_label text, p_request_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.accounts; c public.platform_connections; v_label text := btrim(p_label);
begin
  a := private.lock_owned_account(p_account_id);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  if p_provider is null or p_provider not in ('CTRADER','MT5','MOCK') then
    raise exception 'INVALID_INPUT: provider must be CTRADER, MT5 or MOCK';
  end if;
  if p_provider <> 'MOCK' then
    raise exception 'PROVIDER_NOT_AVAILABLE: % sync is not available in this version', p_provider;
  end if;
  if v_label is null or length(v_label) not between 1 and 60 then
    raise exception 'INVALID_INPUT: label must contain 1 to 60 characters';
  end if;
  select * into c from public.platform_connections where user_id = a.user_id and request_key = p_request_key;
  if found then
    if c.account_id <> a.id or c.provider <> p_provider or c.label <> v_label then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different connection';
    end if;
    return c.id;
  end if;
  -- A connection imports new trades: an archived account takes none (0015 private.require_active_account).
  perform private.require_active_account(a.id);
  select * into c from public.platform_connections where account_id = a.id and provider = p_provider for update;
  if found and private.connection_status(c.id) is distinct from 'DISCONNECTED' then
    return c.id;
  end if;
  if exists (select 1 from public.platform_connections o
              where o.account_id = a.id and o.provider <> p_provider
                and private.connection_status(o.id) is distinct from 'DISCONNECTED') then
    raise exception 'CONNECTION_EXISTS: This trading account already has an active connection';
  end if;
  if c.id is null then
    insert into public.platform_connections(user_id, account_id, provider, label, request_key)
      values (a.user_id, a.id, p_provider, v_label, p_request_key) returning * into c;
  end if;
  insert into public.platform_connection_events(connection_id, user_id, account_id, status)
    values (c.id, c.user_id, c.account_id, 'CONNECTED');
  return c.id;
end $$;

-- Stops syncing; history (executions, links, imported trades) stays. Disconnecting twice is a no-op.
create function public.disconnect_platform_connection(p_connection_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.platform_connections;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  select * into c from public.platform_connections where id = p_connection_id and user_id = auth.uid();
  if not found then raise exception 'CONNECTION_NOT_FOUND: Connection not found'; end if;
  perform private.lock_owned_account(c.account_id);
  perform 1 from public.platform_connections where id = c.id for update;
  if private.connection_status(c.id) is distinct from 'DISCONNECTED' then
    insert into public.platform_connection_events(connection_id, user_id, account_id, status)
      values (c.id, c.user_id, c.account_id, 'DISCONNECTED');
  end if;
  return jsonb_build_object('connectionId', c.id, 'accountId', c.account_id, 'status', 'DISCONNECTED');
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Sync (service_role only). p_user_id comes from the verified session and must own the connection.
-- ---------------------------------------------------------------------------------------------------------
-- Records SYNCING, SYNCED (with the provider time ingested so far, which never moves backwards) or ERROR.
create function public.record_platform_sync_status(p_user_id uuid, p_connection_id uuid, p_status text, p_message text,
  p_synced_through timestamptz) returns bigint
language plpgsql security definer set search_path = '' as $$
declare c public.platform_connections; v_message text := nullif(btrim(p_message), ''); v_previous timestamptz; v_id bigint;
begin
  if p_user_id is null or p_connection_id is null then raise exception 'INVALID_INPUT: user and connection are required'; end if;
  select * into c from public.platform_connections where id = p_connection_id and user_id = p_user_id;
  if not found then raise exception 'CONNECTION_NOT_FOUND: Connection not found'; end if;
  perform 1 from public.platform_connections where id = c.id for update;
  if p_status is null or p_status not in ('SYNCING','SYNCED','ERROR') then
    raise exception 'INVALID_INPUT: status must be SYNCING, SYNCED or ERROR';
  end if;
  if length(v_message) > 300 then raise exception 'INVALID_INPUT: message must contain at most 300 characters'; end if;
  if p_status = 'ERROR' and v_message is null then raise exception 'INVALID_INPUT: An error needs a message'; end if;
  if private.connection_status(c.id) = 'DISCONNECTED' then
    raise exception 'CONNECTION_DISCONNECTED: The connection is disconnected';
  end if;
  if p_synced_through is not null and p_status <> 'SYNCED' then
    raise exception 'INVALID_INPUT: syncedThrough is recorded only with SYNCED';
  end if;
  if p_status = 'SYNCED' then
    select e.synced_through into v_previous from public.platform_connection_events e
     where e.connection_id = c.id and e.status = 'SYNCED' order by e.id desc limit 1;
    if not isfinite(p_synced_through) or p_synced_through > clock_timestamp() then
      raise exception 'INVALID_INPUT: syncedThrough must be a past instant';
    end if;
    if v_previous is not null and (p_synced_through is null or p_synced_through < v_previous) then
      raise exception 'INVALID_INPUT: syncedThrough cannot move backwards';
    end if;
  end if;
  insert into public.platform_connection_events(connection_id, user_id, account_id, status, message, synced_through)
    values (c.id, c.user_id, c.account_id, p_status, v_message, p_synced_through) returning id into v_id;
  return v_id;
end $$;

-- Ingests one normalized platform position with the decision computed by matchExecution (src/domain/sync).
-- Known external id (the decision is not used):
--   payload identical to the stored version or to its appended close -> UNCHANGED (no-op)
--   first stored open, now closed, identity unchanged                 -> CLOSED: the close is appended; an IMPORTED
--                                                                        trade created from it is closed with the
--                                                                        platform P&L (pnl_source IMPORTED). Without
--                                                                        a platform P&L, or when the trade already
--                                                                        has a different recorded close, the trade
--                                                                        is left as it is and a WARNING says why.
--   any other difference                                              -> CHANGED (one WARNING per payload)
-- New external id:
--   {kind:'CREATE'} -> CREATED: IMPORTED trade + position facts (source IMPORT) + IMPORT_CREATED link + the unplanned
--                      close when the position is closed (realized R only with a risk basis, so null at import).
--                      A position closed without a platform P&L is imported open, with the same WARNING as a
--                      platform close without P&L: the trader records the close (close_live_trade).
--   {kind:'LINK', tradeId} -> LINKED (AUTO_MATCH) after re-validating the link rules for a LOCKED or LIVE trade
--   {kind:'HOLD'}   -> HELD: stored unlinked for the trader to confirm
-- Returns {outcome, executionId, tradeId} (tradeId: the trade linked to the execution, if any).
create function public.ingest_external_execution(p_user_id uuid, p_connection_id uuid, p_execution jsonb, p_decision jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.platform_connections; a public.accounts; x public.external_executions; existing public.external_executions;
  platform_close public.external_execution_closes; t public.trades; l public.trade_execution_links;
  recorded public.trade_unplanned_closes; i public.instrument_versions; v_kind text; v_trade_id uuid; v_instrument uuid;
begin
  if p_user_id is null or p_connection_id is null then raise exception 'INVALID_INPUT: user and connection are required'; end if;
  select * into c from public.platform_connections where id = p_connection_id and user_id = p_user_id;
  if not found then raise exception 'CONNECTION_NOT_FOUND: Connection not found'; end if;
  -- Imported trades count toward daily usage: account row first, then the connection (serializes its ingests).
  select * into a from public.accounts where id = c.account_id for update;
  perform 1 from public.platform_connections where id = c.id for update;
  if private.connection_status(c.id) = 'DISCONNECTED' then
    raise exception 'CONNECTION_DISCONNECTED: The connection is disconnected';
  end if;
  perform private.require_object(p_decision, array['kind','tradeId'], 'decision');
  v_kind := private.json_text(p_decision, 'kind');
  if v_kind is null or v_kind not in ('CREATE','LINK','HOLD') then
    raise exception 'INVALID_INPUT: decision kind must be CREATE, LINK or HOLD';
  end if;
  v_trade_id := private.uuid_input(private.json_text(p_decision, 'tradeId'), 'tradeId');
  if (v_kind = 'LINK') <> (v_trade_id is not null) then
    raise exception 'INVALID_INPUT: tradeId is required for LINK and not allowed otherwise';
  end if;
  x := private.external_execution_input(a.currency, p_execution);

  select * into existing from public.external_executions where connection_id = c.id and external_id = x.external_id;
  if found then
    select * into platform_close from public.external_execution_closes where external_execution_id = existing.id;
    l := private.active_execution_link(existing.id);
    if x.payload_hash = existing.payload_hash or x.payload_hash = coalesce(platform_close.payload_hash, '') then
      return jsonb_build_object('outcome', 'UNCHANGED', 'executionId', existing.id, 'tradeId', l.trade_id);
    end if;
    if existing.exited_at is null and platform_close.external_execution_id is null and x.exited_at is not null
       and (x.symbol, x.direction, x.volume, x.entry_price, x.entered_at)
           = (existing.symbol, existing.direction, existing.volume, existing.entry_price, existing.entered_at) then
      insert into public.external_execution_closes(external_execution_id, user_id, account_id, exit_price, exited_at,
          commission, swap, realized_pnl, payload_hash)
        values (existing.id, existing.user_id, existing.account_id, x.exit_price, x.exited_at,
          x.commission, x.swap, x.realized_pnl, x.payload_hash);
      if l.method = 'IMPORT_CREATED' then
        select * into t from public.trades where id = l.trade_id for update;
        select * into recorded from public.trade_unplanned_closes where trade_id = t.id;
        if recorded.trade_id is not null then
          if (recorded.exit_price, recorded.exited_at, recorded.net_pnl) is distinct from (x.exit_price, x.exited_at, x.realized_pnl) then
            perform private.execution_warning(existing, x.payload_hash,
              'was closed on the platform with values that differ from the close recorded in Trading OS; the recorded close was kept.');
          end if;
        elsif x.realized_pnl is null then
          perform private.execution_warning(existing, x.payload_hash,
            'was closed on the platform without a realized P&L; record the close on the trade.');
        else
          perform private.close_imported_trade(t, x.exit_price, x.exited_at, x.commission, x.swap, x.realized_pnl);
        end if;
      end if;
      return jsonb_build_object('outcome', 'CLOSED', 'executionId', existing.id, 'tradeId', l.trade_id);
    end if;
    perform private.execution_warning(existing, x.payload_hash, 'changed on the platform after import; the recorded version was kept.');
    return jsonb_build_object('outcome', 'CHANGED', 'executionId', existing.id, 'tradeId', l.trade_id);
  end if;

  -- A new IMPORTED trade is new activity, which an archived account refuses (0015 private.require_active_account);
  -- positions already imported keep syncing above, and links to existing trades or held executions create no trade.
  if v_kind = 'CREATE' then perform private.require_active_account(c.account_id); end if;
  insert into public.external_executions(user_id, account_id, connection_id, external_id, symbol, direction, volume, entry_price,
      entered_at, exit_price, exited_at, commission, swap, realized_pnl, currency, payload_hash)
    values (c.user_id, c.account_id, c.id, x.external_id, x.symbol, x.direction, x.volume, x.entry_price,
      x.entered_at, x.exit_price, x.exited_at, x.commission, x.swap, x.realized_pnl, x.currency, x.payload_hash)
    returning * into x;

  if v_kind = 'LINK' then
    select * into t from public.trades where id = v_trade_id and user_id = c.user_id for update;
    if not found then raise exception 'TRADE_NOT_FOUND: Trade not found'; end if;
    perform private.check_execution_link(t, x, array['LOCKED','LIVE']);
    insert into public.trade_execution_links(user_id, account_id, trade_id, external_execution_id, action, method)
      values (c.user_id, c.account_id, t.id, x.id, 'LINK', 'AUTO_MATCH');
    return jsonb_build_object('outcome', 'LINKED', 'executionId', x.id, 'tradeId', t.id);
  end if;

  if v_kind = 'HOLD' then
    return jsonb_build_object('outcome', 'HELD', 'executionId', x.id, 'tradeId', null);
  end if;

  -- CREATE. The account's current contract for the symbol is attached only when the position lies on its tick and
  -- size grid (the rule private.check_position applies to entry details); otherwise the trader could never complete
  -- the stop or the money at risk, so the trade is imported without a contract.
  select * into i from public.instrument_versions
   where account_id = c.account_id and symbol = x.symbol order by created_at desc, id desc limit 1;
  if mod(x.entry_price, i.tick_size) = 0 and mod(x.volume, i.quantity_step) = 0 and x.volume >= i.minimum_quantity then
    v_instrument := i.id;
  end if;
  insert into public.trades(user_id, account_id, origin) values (c.user_id, c.account_id, 'IMPORTED') returning * into t;
  insert into public.trade_position_facts(user_id, account_id, trade_id, instrument_version_id, symbol, direction, entry_price,
      entered_at, quantity, source)
    values (c.user_id, c.account_id, t.id, v_instrument, x.symbol, x.direction, x.entry_price, x.entered_at, x.volume, 'IMPORT');
  insert into public.trade_execution_links(user_id, account_id, trade_id, external_execution_id, action, method)
    values (c.user_id, c.account_id, t.id, x.id, 'LINK', 'IMPORT_CREATED');
  if x.exited_at is not null and x.realized_pnl is not null then
    perform private.close_imported_trade(t, x.exit_price, x.exited_at, x.commission, x.swap, x.realized_pnl);
  elsif x.exited_at is not null then
    perform private.execution_warning(x, x.payload_hash, 'was closed on the platform without a realized P&L; record the close on the trade.');
  end if;
  return jsonb_build_object('outcome', 'CREATED', 'executionId', x.id, 'tradeId', t.id);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Trader confirmation (authenticated, owner only, append-only).
-- ---------------------------------------------------------------------------------------------------------
-- Links a stored execution to a planned trade with a locked plan (LOCKED, LIVE, CLOSED or REVIEWED). Linking the
-- same pair again returns the existing link.
create function public.link_external_execution(p_trade_id uuid, p_execution_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; x public.external_executions; l public.trade_execution_links;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  select * into x from public.external_executions where id = p_execution_id and user_id = t.user_id for update;
  if not found then raise exception 'EXECUTION_NOT_FOUND: Platform execution not found'; end if;
  l := private.active_execution_link(x.id);
  if l.trade_id = t.id then return private.link_envelope(l, true); end if;
  perform private.check_execution_link(t, x, array['LOCKED','LIVE','CLOSED','REVIEWED']);
  insert into public.trade_execution_links(user_id, account_id, trade_id, external_execution_id, action, method)
    values (t.user_id, t.account_id, t.id, x.id, 'LINK', 'USER') returning * into l;
  return private.link_envelope(l, false);
end $$;

-- Removes a trader or automatic link; unlinking a pair that is no longer linked returns its latest row.
create function public.unlink_external_execution(p_trade_id uuid, p_execution_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; x public.external_executions; l public.trade_execution_links; latest public.trade_execution_links;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  select * into x from public.external_executions where id = p_execution_id and user_id = t.user_id for update;
  if not found then raise exception 'EXECUTION_NOT_FOUND: Platform execution not found'; end if;
  l := private.active_execution_link(x.id);
  if l.id is null or l.trade_id <> t.id then
    select * into latest from public.trade_execution_links
     where trade_id = t.id and external_execution_id = x.id order by id desc limit 1;
    if found then return private.link_envelope(latest, true); end if;
    raise exception 'LINK_NOT_FOUND: The trade and the platform execution are not linked';
  end if;
  if l.method = 'IMPORT_CREATED' then
    raise exception 'LINK_NOT_REMOVABLE: An imported trade stays linked to the platform position it was created from';
  end if;
  insert into public.trade_execution_links(user_id, account_id, trade_id, external_execution_id, action, method)
    values (t.user_id, t.account_id, t.id, x.id, 'UNLINK', 'USER') returning * into l;
  return private.link_envelope(l, false);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Read models (security_invoker: the RLS of every base table applies). Numbers are canonical text.
-- ---------------------------------------------------------------------------------------------------------
create view public.platform_connection_overview with (security_invoker = true) as
select
  c.id,
  c.account_id,
  c.provider,
  c.label,
  c.external_account_ref,
  c.created_at,
  a.currency,
  state.status,
  state.message as status_message,
  state.recorded_at as status_at,
  synced.synced_through,
  synced.recorded_at as last_synced_at,
  warnings.warning_count,
  warnings.last_warning_at,
  executions.execution_count,
  executions.unmatched_count
from public.platform_connections c
join public.accounts a on a.id = c.account_id
left join lateral (
  select e.status, e.message, e.recorded_at from public.platform_connection_events e
   where e.connection_id = c.id and e.status <> 'WARNING' order by e.id desc limit 1
) state on true
left join lateral (
  select e.synced_through, e.recorded_at from public.platform_connection_events e
   where e.connection_id = c.id and e.status = 'SYNCED' order by e.id desc limit 1
) synced on true
cross join lateral (
  select count(*)::int as warning_count, max(e.recorded_at) as last_warning_at
    from public.platform_connection_events e where e.connection_id = c.id and e.status = 'WARNING'
) warnings
cross join lateral (
  select count(*)::int as execution_count,
         count(*) filter (where latest.action is distinct from 'LINK')::int as unmatched_count
    from public.external_executions x
    left join lateral (
      select l.action from public.trade_execution_links l where l.external_execution_id = x.id order by l.id desc limit 1
    ) latest on true
   where x.connection_id = c.id
) executions;
revoke all on public.platform_connection_overview from public, anon, authenticated, service_role;
grant select on public.platform_connection_overview to authenticated;

-- One row per execution with its effective platform state: the exit fields come from the first version or, for a
-- position first stored open, from its appended close (close_received_at says when the close arrived).
create view public.external_execution_status with (security_invoker = true) as
select
  x.id,
  x.account_id,
  x.connection_id,
  c.provider,
  c.label as connection_label,
  x.external_id,
  x.symbol,
  x.direction,
  trim_scale(x.volume)::text as volume,
  trim_scale(x.entry_price)::text as entry_price,
  x.entered_at,
  trim_scale(coalesce(x.exit_price, platform_close.exit_price))::text as exit_price,
  coalesce(x.exited_at, platform_close.exited_at) as exited_at,
  trim_scale(case when platform_close.external_execution_id is null then x.commission else platform_close.commission end)::text as commission,
  trim_scale(case when platform_close.external_execution_id is null then x.swap else platform_close.swap end)::text as swap,
  trim_scale(case when platform_close.external_execution_id is null then x.realized_pnl else platform_close.realized_pnl end)::text as realized_pnl,
  x.currency,
  coalesce(platform_close.payload_hash, x.payload_hash) as payload_hash,
  x.received_at,
  case when platform_close.external_execution_id is not null then platform_close.recorded_at
       when x.exited_at is not null then x.received_at end as close_received_at,
  case when latest.action = 'LINK' then latest.trade_id end as linked_trade_id,
  case when latest.action = 'LINK' then latest.method end as link_method,
  case when latest.action = 'LINK' then latest.recorded_at end as linked_at,
  warnings.warning_count,
  warnings.last_warning_message,
  warnings.last_warning_at
from public.external_executions x
join public.platform_connections c on c.id = x.connection_id
left join public.external_execution_closes platform_close on platform_close.external_execution_id = x.id
left join lateral (
  select l.trade_id, l.action, l.method, l.recorded_at from public.trade_execution_links l
   where l.external_execution_id = x.id order by l.id desc limit 1
) latest on true
cross join lateral (
  select count(*)::int as warning_count,
         (array_agg(e.message order by e.id desc))[1] as last_warning_message,
         max(e.recorded_at) as last_warning_at
    from public.platform_connection_events e where e.external_execution_id = x.id
) warnings;
revoke all on public.external_execution_status from public, anon, authenticated, service_role;
grant select on public.external_execution_status to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Function privileges: explicit revoke per signature, then the exact grant.
-- ---------------------------------------------------------------------------------------------------------
revoke all on function
  private.connection_status(uuid), private.active_execution_link(uuid), private.active_trade_link(uuid),
  private.normalized_symbol(text), private.external_execution_hash(public.external_executions),
  private.external_execution_input(text, jsonb), private.execution_label(public.external_executions),
  private.execution_warning(public.external_executions, text, text),
  private.close_imported_trade(public.trades, numeric, timestamptz, numeric, numeric, numeric),
  private.check_execution_link(public.trades, public.external_executions, text[]),
  private.guard_execution_links(), private.guard_linked_disposition(), private.link_envelope(public.trade_execution_links, boolean)
  from public, anon, authenticated, service_role;

revoke all on function
  public.create_platform_connection(uuid, text, text, uuid), public.disconnect_platform_connection(uuid),
  public.link_external_execution(uuid, uuid), public.unlink_external_execution(uuid, uuid)
  from public, anon, service_role;
grant execute on function
  public.create_platform_connection(uuid, text, text, uuid), public.disconnect_platform_connection(uuid),
  public.link_external_execution(uuid, uuid), public.unlink_external_execution(uuid, uuid)
  to authenticated;

revoke all on function
  public.ingest_external_execution(uuid, uuid, jsonb, jsonb),
  public.record_platform_sync_status(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.ingest_external_execution(uuid, uuid, jsonb, jsonb),
  public.record_platform_sync_status(uuid, uuid, text, text, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
