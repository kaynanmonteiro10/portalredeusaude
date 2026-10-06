create table if not exists public.portal_state (
  id integer primary key check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.users (
  id uuid primary key,
  username text unique not null,
  display_name text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'user')),
  sector_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  token text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.screens (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('builtin', 'sector')),
  sector text not null default '',
  description text not null default '',
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.user_screens (
  user_id uuid not null references public.users(id) on delete cascade,
  screen_id text not null references public.screens(id) on delete cascade,
  primary key (user_id, screen_id)
);

create table if not exists public.sectors (
  id text primary key,
  name text unique not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.user_sectors (
  user_id uuid not null references public.users(id) on delete cascade,
  sector_id text not null references public.sectors(id) on delete cascade,
  primary key (user_id, sector_id)
);

alter table public.portal_state enable row level security;
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.screens enable row level security;
alter table public.user_screens enable row level security;
alter table public.sectors enable row level security;
alter table public.user_sectors enable row level security;

create index if not exists sessions_user_id_idx on public.sessions(user_id);
create index if not exists user_screens_screen_id_idx on public.user_screens(screen_id);
create index if not exists user_sectors_sector_id_idx on public.user_sectors(sector_id);
