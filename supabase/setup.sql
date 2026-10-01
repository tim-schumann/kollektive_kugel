-- Tile draw: database setup for Supabase
-- Paste this whole file into Supabase → SQL Editor → Run. Safe to run again.

-- 1. Tables -------------------------------------------------------------------

create table if not exists public.students (
  student_id text primary key
);

create table if not exists public.tiles (
  code        text primary key,                        -- e.g. 'Typ 1 - Gruppe 13 - Feld 7'
  tile_type   smallint not null check (tile_type in (1, 2)),
  ico_face    smallint not null check (ico_face between 1 and 20),
  sub_face    smallint not null check (sub_face between 1 and 9),
  student_id  text unique references public.students (student_id) on delete set null,
  assigned_at timestamptz
);

-- 2. The 180 tiles (sub-faces 1, 5, 9 touch an icosahedron vertex = Typ 1) -------

-- Brings codes from an earlier run into the current format; assignments are kept.
update public.tiles
set code = format('Typ %s - Gruppe %s - Feld %s', tile_type, ico_face, sub_face)
where code <> format('Typ %s - Gruppe %s - Feld %s', tile_type, ico_face, sub_face);

insert into public.tiles (code, tile_type, ico_face, sub_face)
select format('Typ %s - Gruppe %s - Feld %s', t.tile_type, f, s), t.tile_type, f, s
from generate_series(1, 20) as f,
     generate_series(1, 9)  as s,
     lateral (select case when s in (1, 5, 9) then 1 else 2 end as tile_type) as t
on conflict (code) do nothing;

-- 3. Lock the tables: with RLS on and no policies, the public API can't read
--    or write them. The website only talks to the two functions below.

alter table public.students enable row level security;
alter table public.tiles    enable row level security;

-- 4. roll_dice: validates the ID, returns an existing tile or assigns a new
--    random free one. Runs as the table owner (security definer).

create or replace function public.roll_dice(p_student_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   text := trim(p_student_id);
  v_tile public.tiles%rowtype;
begin
  if v_id is null or v_id = ''
     or not exists (select 1 from public.students where student_id = v_id) then
    return json_build_object('status', 'invalid');
  end if;

  -- Two clicks at the same moment for the same student can't both assign.
  perform pg_advisory_xact_lock(hashtext(v_id));

  select * into v_tile from public.tiles where student_id = v_id;
  if found then
    return json_build_object('status', 'existing', 'code', v_tile.code,
                             'ico_face', v_tile.ico_face, 'sub_face', v_tile.sub_face);
  end if;

  select * into v_tile
  from public.tiles
  where student_id is null
  order by random()
  limit 1
  for update skip locked;          -- different students never get the same tile

  if not found then
    return json_build_object('status', 'full');
  end if;

  update public.tiles
  set student_id = v_id, assigned_at = now()
  where code = v_tile.code;

  return json_build_object('status', 'assigned', 'code', v_tile.code,
                           'ico_face', v_tile.ico_face, 'sub_face', v_tile.sub_face);
end;
$$;

-- 5. tiles_left: number of free tiles, shown under the button.

create or replace function public.tiles_left()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from public.tiles where student_id is null;
$$;

-- 6. group_status: which fields (1–9) of a group are taken, for "Gruppe anzeigen".
--    Returns only field numbers, never who has them.

create or replace function public.group_status(p_ico_face integer)
returns smallint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(sub_face order by sub_face), '{}')
  from public.tiles
  where ico_face = p_ico_face and student_id is not null;
$$;

revoke all on function public.roll_dice(text)       from public;
revoke all on function public.tiles_left()          from public;
revoke all on function public.group_status(integer) from public;
grant execute on function public.roll_dice(text)       to anon;
grant execute on function public.tiles_left()          to anon;
grant execute on function public.group_status(integer) to anon;
