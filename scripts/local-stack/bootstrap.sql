-- Supabase compatibility bootstrap for the LOCAL development stack only.
-- Applied once to a fresh database (by start.mjs / reset.mjs) BEFORE supabase/migrations/*.sql.
-- It recreates the platform objects the repository migrations and the app rely on: Supabase API
-- roles, the auth schema (users/sessions/tokens + auth.uid()/role()/jwt()), the storage schema
-- (buckets/objects with RLS) and Supabase's default grants. It is not a full Supabase schema.
--
-- psql variables (supplied by start.mjs): authenticator_password
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------------
-- API roles (as in supabase/postgres initial schema)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
alter role service_role bypassrls;
alter role authenticator login noinherit;
alter role authenticator with password :'authenticator_password';
grant anon, authenticated, service_role to authenticator;
-- Supabase's default API statement timeouts. PostgREST applies impersonated role settings.
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

-- ---------------------------------------------------------------------------------------------
-- Extensions schema (Supabase installs pgcrypto/uuid-ossp there and puts it on the search path)
-- ---------------------------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
alter role postgres set search_path to "$user", public, extensions;

-- ---------------------------------------------------------------------------------------------
-- public schema grants: Supabase defaults. New objects created by postgres (the migration role)
-- are granted to the API roles; every repository migration then revokes/grants per object, so
-- the effective privileges match the hosted project. status.mjs reports any anon-visible table.
-- ---------------------------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- auth schema (subset of GoTrue's schema used by the local gateway)
-- ---------------------------------------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud varchar(255) default 'authenticated',
  role varchar(255) default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token text,
  confirmation_sent_at timestamptz,
  recovery_token text,
  recovery_sent_at timestamptz,
  email_change text,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_super_admin boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  phone text unique,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_sso_user boolean not null default false,
  is_anonymous boolean not null default false
);
comment on table auth.users is 'Local stack: GoTrue-compatible user records (synthetic users only).';

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  email text generated always as (lower(identity_data ->> 'email')) stored,
  unique (provider_id, provider)
);

create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  aal text not null default 'aal1',
  amr jsonb not null default '[]'::jsonb,
  not_after timestamptz,
  refreshed_at timestamptz,
  user_agent text,
  ip text
);
create index if not exists sessions_user_id_idx on auth.sessions(user_id);

create table if not exists auth.refresh_tokens (
  id bigserial primary key,
  token text not null unique,
  user_id uuid not null,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  parent text,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists refresh_tokens_session_idx on auth.refresh_tokens(session_id, revoked);

-- PKCE state (resetPasswordForEmail with flowType "pkce" -> /verify -> /token?grant_type=pkce)
create table if not exists auth.flow_state (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade,
  auth_code text not null unique,
  code_challenge_method text not null check (code_challenge_method in ('s256', 'plain')),
  code_challenge text not null,
  provider_type text not null,
  authentication_method text not null,
  auth_code_issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Emailed one-time tokens (recovery links). Only the SHA-256 hash of the link token is stored.
create table if not exists auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_type text not null,
  token_hash text not null unique,
  relates_to text not null,
  flow_state_id uuid references auth.flow_state(id) on delete set null,
  redirect_to text,
  created_at timestamptz not null default now()
);

-- Supabase-compatible claim helpers: read the legacy per-claim GUC or PostgREST's JSON GUC.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- storage schema (subset of supabase/storage's schema). The gateway evaluates every user/anon
-- object operation as SQL on storage.objects under the caller's role and JWT claims, so RLS
-- policies (including supabase/migrations/0005) are enforced exactly where Supabase enforces them.
-- ---------------------------------------------------------------------------------------------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;
alter default privileges for role postgres in schema storage grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema storage grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema storage grant all on sequences to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  owner_id text,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  type text not null default 'STANDARD',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists bname on storage.buckets using btree (name);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  version text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  path_tokens text[] generated always as (string_to_array(name, '/')) stored
);
create unique index if not exists bucketid_objname on storage.objects using btree (bucket_id, name);
create index if not exists name_prefix_search on storage.objects using btree (name text_pattern_ops);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

create or replace function storage.update_updated_at_column() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists update_objects_updated_at on storage.objects;
create trigger update_objects_updated_at before update on storage.objects
  for each row execute function storage.update_updated_at_column();

-- Path helpers commonly used in Supabase storage policies.
create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
create or replace function storage.filename(name text) returns text language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;
create or replace function storage.extension(name text) returns text language plpgsql immutable as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Migration ledger, same shape as the Supabase CLI / production project ledger.
-- ---------------------------------------------------------------------------------------------
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
revoke all on schema supabase_migrations from public;

-- Local tooling metadata (bootstrap checksum etc.). Not exposed through PostgREST.
create schema if not exists local_stack;
revoke all on schema local_stack from public;
create table if not exists local_stack.meta (key text primary key, value text not null, updated_at timestamptz not null default now());
