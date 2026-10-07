# Kollektive Kugel: Erspiele dein Paneel!

Students enter their ID, the 3-frequency geodesic sphere spins and stops on a random free panel, which is saved in the database. Each of the 180 panels goes to exactly one student. Course: Digitales Gestalten I 2026, Fachgebiet Digitales Gestalten, TU Darmstadt.

- Frontend: static site (three.js from a CDN), hosted on GitHub Pages
- Backend: Supabase (free tier), one table of valid IDs, one table of panels, three database functions

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

After a draw, "Gruppe anzeigen" zooms onto the student's group and shows which of its fields are already taken (not by whom). The sphere can be dragged to turn it.

## 1. Try it locally

From the repository root:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. (Opening `index.html` directly as a file won't load the modules.)

**If `config.js` contains the Supabase URL and key, the local page uses the live database.** Rolling with an ID from the student list saves a real assignment. Free it again afterwards (see "Managing the draw").

For a test without a database, empty `SUPABASE_URL` and `SUPABASE_KEY` in `config.js` (don't commit that). The page then runs in demo mode with the test IDs `1234567` and `7654321`, 60 panels pre-assigned, nothing saved.

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
4. Click **Connect** at the top of the dashboard (or look under **Project Settings**) and copy the project URL and the **publishable** key (older projects: the `anon` key). Put both into `config.js`.

The key is meant to be public. The tables have row-level security switched on with no policies, so the website can only call `roll_dice`, `tiles_left` and `group_status`; nobody can read the ID list or the assignments.

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
```

To export the results, run the first query and use **Export → CSV** in the results panel.

## Good to know

- Free Supabase projects are paused after about a week without activity. Open the dashboard a day before the session and restore the project if needed. Otherwise students only see "Keine Verbindung zur Datenbank".
- Anyone who knows a classmate's ID could roll for them, and a script could test which IDs are on the list. Possible fixes: a personal code per student in addition to the ID, or a login through Moodle (LTI 1.3).
- The draw happens on the server, so reloading the page or editing the JavaScript can't change a result.
