-- FOUNDATION TEMPLATE, not a completed Mission backend. Apply only to a development project.
-- TODO (backend + core): atomic edit/claim/complete/cancel/publish/register RPCs,
-- immutable revision/artifact enforcement, events and quota reservations.
-- No public reads or browser writes are enabled by this migration.
begin;

create table public.missions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  goal text not null check (char_length(goal) between 1 and 4000),
  template text not null default 'workshop-launch' check (template = 'workshop-launch'),
  inputs jsonb check (inputs is null or jsonb_typeof(inputs) = 'object'),
  revision integer not null default 1 check (revision >= 1),
  run_id uuid,
  generation integer not null default 0 check (generation >= 0),
  stop_epoch integer not null default 0 check (stop_epoch >= 0),
  execution_state text not null default 'draft'
    check (execution_state in ('draft', 'running', 'needs_input', 'ready_for_review', 'failed')),
  published_bundle_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index missions_owner_id on public.missions(owner_id);

create table public.mission_revisions (
  mission_id uuid not null references public.missions(id) on delete cascade,
  revision integer not null check (revision >= 1),
  inputs jsonb check (inputs is null or jsonb_typeof(inputs) = 'object'),
  file_manifest jsonb not null default '[]' check (jsonb_typeof(file_manifest) = 'array'),
  created_at timestamptz not null default now(),
  primary key (mission_id, revision)
);

create table public.mission_files (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  revision integer not null,
  name text not null,
  version integer not null check (version >= 1),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  storage_path text not null,
  size_bytes integer not null check (size_bytes between 0 and 200000),
  foreign key (mission_id, revision) references public.mission_revisions(mission_id, revision) on delete cascade
);

create table public.mission_tasks (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  revision integer not null,
  run_id uuid not null,
  generation integer not null check (generation >= 0),
  stop_epoch integer not null check (stop_epoch >= 0),
  task_key text not null check (task_key in ('intake', 'budget_capacity', 'agenda', 'event_content', 'validate_bundle')),
  status text not null default 'ready' check (status in ('ready', 'running', 'blocked', 'succeeded', 'failed', 'stale', 'cancelled')),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  readset jsonb not null check (jsonb_typeof(readset) = 'object'),
  depends_on jsonb not null default '[]' check (jsonb_typeof(depends_on) = 'array'),
  attempt integer not null default 0 check (attempt between 0 and 2),
  claim_token uuid,
  lease_until timestamptz,
  error text,
  foreign key (mission_id, revision) references public.mission_revisions(mission_id, revision) on delete cascade,
  unique (mission_id, run_id, generation, task_key),
  unique (id, mission_id, revision),
  check (status <> 'running' or (claim_token is not null and lease_until is not null))
);

create table public.mission_artifacts (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  revision integer not null,
  task_id uuid not null,
  kind text not null check (kind in ('budget', 'agenda', 'event', 'audio')),
  version integer not null check (version >= 1),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text not null check (output_hash ~ '^[a-f0-9]{64}$'),
  content jsonb not null,
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  foreign key (task_id, mission_id, revision) references public.mission_tasks(id, mission_id, revision) on delete cascade,
  unique (task_id, kind, version)
);

create table public.mission_bundles (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  revision integer not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  checks jsonb not null check (jsonb_typeof(checks) = 'array'),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (mission_id, revision) references public.mission_revisions(mission_id, revision) on delete cascade,
  unique (id, mission_id)
);
alter table public.missions add constraint published_bundle_same_mission
  foreign key (published_bundle_id, id) references public.mission_bundles(id, mission_id) deferrable initially deferred;

create table public.mission_registrations (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions(id) on delete cascade,
  bundle_id uuid not null,
  client_request_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 80),
  created_at timestamptz not null default now(),
  foreign key (bundle_id, mission_id) references public.mission_bundles(id, mission_id),
  unique (mission_id, client_request_id)
);

-- RLS + explicit grants. Child tables remain server-only, including task claim tokens.
do $$
declare table_name text;
begin
  foreach table_name in array array['missions', 'mission_revisions', 'mission_files', 'mission_tasks',
    'mission_artifacts', 'mission_bundles', 'mission_registrations']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end $$;
grant select on public.missions to authenticated;
create policy missions_owner_read on public.missions for select to authenticated
  using ((select auth.uid()) = owner_id);

-- No storage.objects policies yet. Backend must authorize owner + immutable object path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mission-files', 'mission-files', false, 200000, array['text/plain', 'text/markdown', 'text/csv']);

commit;
