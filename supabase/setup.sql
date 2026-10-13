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

-- 2. The 180 tiles (sub-faces 1, 5, 9 touch an icosahedron vertex = Typ 2,
--    all others = Typ 1). Mirrors geodesic.js; change both together. ---------

-- Brings types and codes from an earlier run up to date; assignments are kept.
update public.tiles
set tile_type = case when sub_face in (1, 5, 9) then 2 else 1 end
where tile_type <> case when sub_face in (1, 5, 9) then 2 else 1 end;

update public.tiles
set code = format('Typ %s - Gruppe %s - Feld %s', tile_type, ico_face, sub_face)
where code <> format('Typ %s - Gruppe %s - Feld %s', tile_type, ico_face, sub_face);

insert into public.tiles (code, tile_type, ico_face, sub_face)
select format('Typ %s - Gruppe %s - Feld %s', t.tile_type, f, s), t.tile_type, f, s
from generate_series(1, 20) as f,
     generate_series(1, 9)  as s,
     lateral (select case when s in (1, 5, 9) then 2 else 1 end as tile_type) as t
on conflict (code) do nothing;

-- 3. Lock the tables: with RLS on and no policies, the public API can't read
--    or write them. The website only talks to the functions below.

alter table public.students enable row level security;
alter table public.tiles    enable row level security;

-- 4. Login. The password is never stored in this file (it's public on GitHub):
--    set it once in the SQL Editor, see README "Passwort setzen". A student's
--    own password_hash, if set, takes precedence over the course password.

create extension if not exists pgcrypto with schema extensions;

alter table public.students add column if not exists password_hash text;

create table if not exists public.app_settings (
  key   text primary key,                                -- 'default_password_hash'
  value text not null
);

create table if not exists public.sessions (
  token_hash text primary key,                           -- sha256 of the token the browser holds
  student_id text not null references public.students (student_id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists public.login_failures (
  student_id text not null,
  failed_at  timestamptz not null default now()
);

-- 5. Designs: one per panel, replaced on every new upload. `image` is the
--    student's PNG (redrawn in the browser, max. 2 MB), `texture` a small JPEG
--    for the sphere.

create table if not exists public.designs (
  code       text primary key references public.tiles (code) on update cascade on delete cascade,
  student_id text not null references public.students (student_id) on delete cascade,
  image      bytea not null,
  texture    bytea not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings   enable row level security;
alter table public.sessions       enable row level security;
alter table public.login_failures enable row level security;
alter table public.designs        enable row level security;

-- Student behind a session token, or null if the token is unknown or expired.
create or replace function public.session_student(p_token text)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select student_id from public.sessions
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and expires_at > now();
$$;

create or replace function public.tile_of(p_student_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('code', code, 'ico_face', ico_face, 'sub_face', sub_face)
  from public.tiles where student_id = p_student_id;
$$;

-- student_login: checks ID and password, returns a session token (12 h) and
-- the student's tile, if any. 10 wrong attempts per ID lock it for 15 minutes.
create or replace function public.student_login(p_student_id text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id    text := trim(p_student_id);
  v_hash  text;
  v_known boolean;
  v_token text;
begin
  if v_id is null or v_id = '' or length(v_id) > 64
     or p_password is null or length(p_password) > 200 then
    return jsonb_build_object('status', 'invalid');
  end if;

  delete from public.login_failures where failed_at < now() - interval '1 day';
  if (select count(*) from public.login_failures
      where student_id = v_id and failed_at > now() - interval '15 minutes') >= 10 then
    return jsonb_build_object('status', 'locked');
  end if;

  select password_hash into v_hash from public.students where student_id = v_id;
  v_known := found;
  v_hash := coalesce(v_hash, (select value from public.app_settings where key = 'default_password_hash'));
  if v_hash is null then
    return jsonb_build_object('status', 'no_password');
  end if;

  -- The hash is checked for unknown IDs too, so the answer takes equally long.
  if crypt(p_password, v_hash) <> v_hash or not v_known then
    insert into public.login_failures (student_id) values (v_id);
    return jsonb_build_object('status', 'invalid');
  end if;

  delete from public.sessions where expires_at < now();
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.sessions (token_hash, student_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_id, now() + interval '12 hours');

  return jsonb_build_object('status', 'ok', 'token', v_token,
                            'student_id', v_id, 'tile', public.tile_of(v_id));
end;
$$;

-- student_session: the logged-in student and their tile, after a page reload.
create or replace function public.student_session(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id text := public.session_student(p_token);
begin
  if v_id is null then
    return jsonb_build_object('status', 'expired');
  end if;
  return jsonb_build_object('status', 'ok', 'student_id', v_id, 'tile', public.tile_of(v_id));
end;
$$;

create or replace function public.student_logout(p_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.sessions
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  select true;
$$;

-- 6. roll_dice: returns the student's existing tile or assigns a new random
--    free one. Runs as the table owner (security definer).

drop function if exists public.roll_dice(text);           -- the old version took the bare ID

create or replace function public.roll_dice(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   text := public.session_student(p_token);
  v_tile public.tiles%rowtype;
begin
  if v_id is null then
    return json_build_object('status', 'expired');
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

-- 7. tiles_left: number of free tiles, shown under the button.

create or replace function public.tiles_left()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from public.tiles where student_id is null;
$$;

-- 8. group_status: which fields (1–9) of a group are taken, for "Gruppe anzeigen".
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

-- 9. File checks, repeated here because the browser can be bypassed.
--    PNG: signature, IHDR first (64–4096 px), only image chunks (no text,
--    metadata or unknown chunks), IEND last with nothing after it.

create or replace function public.valid_png(p_data bytea, p_max_bytes integer)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  n      integer := length(p_data);
  o      integer := 8;                                   -- 0-based offset of the current chunk
  len    bigint;
  typ    text;
  w      bigint;
  h      bigint;
  idat   boolean := false;
  chunks integer := 0;
begin
  if p_data is null or n < 57 or n > p_max_bytes
     or substring(p_data from 1 for 8) <> '\x89504e470d0a1a0a'::bytea then
    return false;
  end if;
  loop
    chunks := chunks + 1;
    if chunks > 10000 or o + 12 > n then return false; end if;
    len := (get_byte(p_data, o)::bigint << 24) + (get_byte(p_data, o + 1) << 16)
         + (get_byte(p_data, o + 2) << 8) + get_byte(p_data, o + 3);
    if o + 12 + len > n then return false; end if;
    typ := encode(substring(p_data from o + 5 for 4), 'hex');
    if o = 8 then
      if typ <> '49484452' or len <> 13 then return false; end if;      -- IHDR
      w := (get_byte(p_data, o + 8)::bigint << 24) + (get_byte(p_data, o + 9) << 16)
         + (get_byte(p_data, o + 10) << 8) + get_byte(p_data, o + 11);
      h := (get_byte(p_data, o + 12)::bigint << 24) + (get_byte(p_data, o + 13) << 16)
         + (get_byte(p_data, o + 14) << 8) + get_byte(p_data, o + 15);
      if w not between 64 and 4096 or h not between 64 and 4096 then return false; end if;
    elsif typ = '49444154' then                                          -- IDAT
      idat := true;
    elsif typ = '49454e44' then                                          -- IEND
      return idat and len = 0 and o + 12 = n;
    elsif typ not in ('504c5445', '74524e53', '73524742', '67414d41', '6348524d') then
      return false;                                                      -- not PLTE tRNS sRGB gAMA cHRM
    end if;
    o := o + 12 + len::integer;
  end loop;
end;
$$;

create or replace function public.valid_jpeg(p_data bytea, p_max_bytes integer)
returns boolean
language sql
immutable
as $$
  select p_data is not null
     and length(p_data) between 125 and p_max_bytes
     and substring(p_data from 1 for 3) = '\xffd8ff'::bytea
     and substring(p_data from length(p_data) - 1 for 2) = '\xffd9'::bytea;
$$;

-- 10. upload_design: stores (or replaces) the design for the student's tile.
--     Both files come base64-encoded.

create or replace function public.upload_design(p_token text, p_image text, p_texture text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      text := public.session_student(p_token);
  v_code    text;
  v_image   bytea;
  v_texture bytea;
  v_time    timestamptz;
begin
  if v_id is null then
    return jsonb_build_object('status', 'expired');
  end if;
  select code into v_code from public.tiles where student_id = v_id;
  if v_code is null then
    return jsonb_build_object('status', 'no_tile');
  end if;

  if length(p_image) > 2796204 or length(p_texture) > 699052 then  -- base64 of 2 MB / 512 KB
    return jsonb_build_object('status', 'invalid_file');
  end if;
  begin
    v_image := decode(p_image, 'base64');
    v_texture := decode(p_texture, 'base64');
  exception when others then
    return jsonb_build_object('status', 'invalid_file');
  end;
  if not public.valid_png(v_image, 2097152) or not public.valid_jpeg(v_texture, 524288) then
    return jsonb_build_object('status', 'invalid_file');
  end if;

  insert into public.designs (code, student_id, image, texture, updated_at)
  values (v_code, v_id, v_image, v_texture, now())
  on conflict (code) do update
    set student_id = excluded.student_id, image = excluded.image,
        texture = excluded.texture, updated_at = excluded.updated_at
  returning updated_at into v_time;

  return jsonb_build_object('status', 'ok', 'updated_at', v_time);
end;
$$;

-- 11. list_designs / design_textures: for "Panels laden". Only designs whose
--     tile still belongs to the uploader count. Textures come in batches.

create or replace function public.list_designs(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.session_student(p_token) is null then
    return jsonb_build_object('status', 'expired');
  end if;
  return jsonb_build_object('status', 'ok', 'designs', coalesce((
    select jsonb_agg(jsonb_build_object('code', t.code, 'ico_face', t.ico_face,
                                        'sub_face', t.sub_face, 'updated_at', d.updated_at))
    from public.designs d
    join public.tiles t on t.code = d.code and t.student_id = d.student_id
  ), '[]'::jsonb));
end;
$$;

create or replace function public.design_textures(p_token text, p_codes text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.session_student(p_token) is null then
    return jsonb_build_object('status', 'expired');
  end if;
  if coalesce(cardinality(p_codes), 0) > 30 then
    return jsonb_build_object('status', 'too_many');
  end if;
  return jsonb_build_object('status', 'ok', 'textures', coalesce((
    select jsonb_agg(jsonb_build_object('code', t.code, 'ico_face', t.ico_face,
                                        'sub_face', t.sub_face, 'updated_at', d.updated_at,
                                        'texture', translate(encode(d.texture, 'base64'), E'\n', '')))
    from public.designs d
    join public.tiles t on t.code = d.code and t.student_id = d.student_id
    where d.code = any (p_codes)
  ), '[]'::jsonb));
end;
$$;

-- 12. Permissions: the website may call only these functions. Supabase grants
--     new functions to anon and authenticated by default, so revoke from all.

revoke all on function public.session_student(text)                from public, anon, authenticated;
revoke all on function public.tile_of(text)                        from public, anon, authenticated;
revoke all on function public.valid_png(bytea, integer)            from public, anon, authenticated;
revoke all on function public.valid_jpeg(bytea, integer)           from public, anon, authenticated;
revoke all on function public.student_login(text, text)            from public, anon, authenticated;
revoke all on function public.student_session(text)                from public, anon, authenticated;
revoke all on function public.student_logout(text)                 from public, anon, authenticated;
revoke all on function public.roll_dice(text)                      from public, anon, authenticated;
revoke all on function public.tiles_left()                         from public, anon, authenticated;
revoke all on function public.group_status(integer)                from public, anon, authenticated;
revoke all on function public.upload_design(text, text, text)      from public, anon, authenticated;
revoke all on function public.list_designs(text)                   from public, anon, authenticated;
revoke all on function public.design_textures(text, text[])        from public, anon, authenticated;

grant execute on function public.student_login(text, text)         to anon;
grant execute on function public.student_session(text)             to anon;
grant execute on function public.student_logout(text)              to anon;
grant execute on function public.roll_dice(text)                   to anon;
grant execute on function public.tiles_left()                      to anon;
grant execute on function public.group_status(integer)             to anon;
grant execute on function public.upload_design(text, text, text)   to anon;
grant execute on function public.list_designs(text)                to anon;
grant execute on function public.design_textures(text, text[])     to anon;

notify pgrst, 'reload schema';
