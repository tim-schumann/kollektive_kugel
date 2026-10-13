# Kollektive Kugel

Students log in with their ID and the course password, the 3-frequency geodesic sphere spins and stops on a random free panel, which is saved in the database. Each of the 180 panels goes to exactly one student, who then uploads a PNG design for its filling. Course: Digitales Gestalten I 2026, Fachgebiet Digitales Gestalten, TU Darmstadt.

- Frontend: static site (three.js from a CDN), hosted on GitHub Pages
- Backend: Supabase (free tier): tables for IDs, panels, sessions and designs, reached only through database functions

```
index.html          page + styles
main.js             scene, animation, UI flow
geodesic.js         geometry and panel numbering
config.js           Supabase URL + key, page texts
supabase/setup.sql  database setup (run once, safe to run again)
```

## Panel codes

`Typ 1 - Gruppe 13 - Feld 7` = type, group (icosahedron face 1–20), field (sub-face 1–9).

- Groups: 1–5 top cap, 6–10 upper belt, 11–15 lower belt, 16–20 bottom cap.
- Fields are numbered row by row from the group's tip (the pole for cap groups, the pointed end for belt groups): 1 / 2 3 4 / 5 6 7 8 9.
- Fields 1, 5, 9 touch an icosahedron vertex: Typ 2, the small panels (60). The rest are Typ 1, the large panels (120).
- The numbering and the type rule live in `geodesic.js` and are mirrored in `supabase/setup.sql`. Change both together.

## Frame and filling

Each panel consists of a frame and a filling. The frame is the whole panel; the filling is the panel with every edge moved 15 mm inwards. The "Rahmen" / "Füllung" switch above the sphere shows one or the other. Sizes at Ø 1200 mm, node to node:

| Panel | Frame edges | Filling edges |
|---|---|---|
| Typ 1 (large) | 242 / 247 / 247 mm | 191 / 195 / 195 mm |
| Typ 2 (small) | 209 / 209 / 242 mm | 159 / 159 / 184 mm |

"Kantenlängen (mm)" shows these lengths on the sphere, for whichever view is active. "Beschriftung" shows type, group and field on every panel (T / G / F), which is useful for checking against the physical model. The inset is set by `FILLING_INSET_MM` in `main.js`.

After a draw, "Gruppe anzeigen" zooms onto the student's group and shows which of its fields are already taken (not by whom); "Paneel anzeigen" zooms onto the student's own panel. The sphere can be dragged to turn it.

## Login and designs

The page stays covered until the student logs in with their ID and the course password. A login lasts 12 hours (or until "Abmelden" / closing the tab). Ten wrong passwords for one ID lock that ID for 15 minutes.

"Upload Design" takes a PNG of the filling only (no frame): the isosceles triangle with its base along the bottom edge of the image and its apex at the middle of the top edge, seen from outside the sphere. Format: Typ 1 191 × 170 mm, Typ 2 184 × 130 mm (the page tells each student theirs; the aspect ratio may be off by 5 %). The image is stretched onto the filling, previewed on the sphere, and saved only after "Akzeptieren". A new upload replaces the old one. "Panels laden" shows everyone's designs.

File checks, in the browser: max. 2 MB, a plain file name ending in `.png`, a structurally valid PNG with nothing appended, 64–4096 px per side (read from the header before decoding), matching aspect ratio. The image is then decoded and redrawn on a canvas, so only its pixels are stored, not the original file: metadata, text chunks or anything hidden in it are dropped. The database checks the redrawn files again (PNG structure and allowed chunks, JPEG markers, sizes), since the browser checks can be bypassed. File names are not stored. Images are only ever decoded as images, never served as files.

Each design is stored twice: the redrawn PNG (max. 1600 px wide, max. 2 MB) and a 512 px JPEG for the sphere. 180 full-size designs can add up to a few hundred MB; the free Supabase plan allows 500 MB, so check **Database → Usage** now and then.

## 1. Try it locally

From the repository root:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. (Opening `index.html` directly as a file won't load the modules.)

**If `config.js` contains the Supabase URL and key, the local page uses the live database.** Rolling with an ID from the student list saves a real assignment. Free it again afterwards (see "Managing the draw").

For a test without a database, empty `SUPABASE_URL` and `SUPABASE_KEY` in `config.js` (don't commit that). The page then runs in demo mode with the test IDs `1234567` and `7654321`, password `demo`, 60 panels pre-assigned, nothing saved.

## 2. Set up Supabase

1. Create a free account at supabase.com and a new project. Frankfurt (eu-central-1) keeps the data in Germany.
2. Open **SQL Editor**, paste the contents of `supabase/setup.sql`, and click **Run**. If you ran an older version of the script, just run the new one again: it updates types and codes and keeps existing assignments.
3. Import the student IDs: **Table Editor → students → Insert → Import data from CSV**. The CSV needs a header row named `student_id`, for example:

   ```
   student_id
   2412345
   2412346
   ```

   IDs are stored as text, so leading zeros survive.
4. Set the course password (see "Passwort setzen" below). Without it nobody can log in.
5. Click **Connect** at the top of the dashboard (or look under **Project Settings**) and copy the project URL and the **publishable** key (older projects: the `anon` key). Put both into `config.js`.

The key is meant to be public. The tables have row-level security switched on with no policies, so the website can only call the functions granted at the end of `setup.sql`; nobody can read the ID list, the passwords or the assignments.

**Upgrading from the version without login:** the new `setup.sql` replaces `roll_dice`, so the old page stops working once it has run. Run it and publish the new page at the same time.

### Passwort setzen

The password is stored only as a bcrypt hash in the database, never in this repository (which is public). Run in the SQL Editor, with the real password in place of `PASSWORT`:

```sql
insert into app_settings (key, value)
values ('default_password_hash', extensions.crypt('PASSWORT', extensions.gen_salt('bf')))
on conflict (key) do update set value = excluded.value;
```

Run it again to change the password; logged-in students stay logged in until their session ends. To give one student their own password instead:

```sql
update students set password_hash = extensions.crypt('PASSWORT', extensions.gen_salt('bf'))
where student_id = '2412345';
```

## 3. Publish on GitHub Pages

1. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`, and save.
2. After a minute the site is live at `https://<username>.github.io/<repository>/`.

Test it once with your own ID from the CSV, then free that entry again (see below).

## Managing the draw

Run these in the Supabase SQL Editor.

```sql
-- All assignments
select student_id, code, assigned_at from tiles
where student_id is not null order by assigned_at;

-- Free a student's panel so they can roll again
update tiles set student_id = null, assigned_at = null where student_id = '2412345';

-- Reset the whole draw
update tiles set student_id = null, assigned_at = null;

-- Add a late student
insert into students (student_id) values ('2412399');

-- Uploaded designs (the PNG is in `image`, the sphere texture in `texture`)
select code, student_id, updated_at, length(image) as bytes from designs order by updated_at;

-- Delete a design
delete from designs where code = 'Typ 1 - Gruppe 13 - Feld 7';

-- Log everyone out
delete from sessions;

-- Unlock an ID after too many wrong passwords
delete from login_failures where student_id = '2412345';
```

To export the results, run the first query and use **Export → CSV** in the results panel.

## Good to know

- Free Supabase projects are paused after about a week without activity. Open the dashboard a day before the session and restore the project if needed. Otherwise students only see "Keine Verbindung zur Datenbank".
- The course password is shared, so anyone in the course who knows a classmate's ID could log in as them (roll their panel, replace their design). For more, give students their own passwords (see "Passwort setzen") or use a login through Moodle (LTI 1.3). Wrong passwords can also lock a classmate's ID for 15 minutes.
- The draw happens on the server, so reloading the page or editing the JavaScript can't change a result.
