# Geodesic tile draw

Students enter their ID, the 3-frequency geodesic sphere spins and stops on a random free tile, which is saved in the database. Each of the 180 tiles goes to exactly one student.

- Frontend: static site (three.js from a CDN), hosted on GitHub Pages
- Backend: Supabase (free tier), one table of valid IDs, one table of tiles, one database function that does the draw

```
index.html          page + styles
main.js             scene, animation, UI flow
geodesic.js         geometry and tile numbering
config.js           Supabase URL + key, page title
supabase/setup.sql  database setup (run once)
```

## Panel codes

`Typ 1 - Gruppe 13 - Feld 7` = type, group (icosahedron face 1–20), field (sub-face 1–9).

- Groups: 1–5 top cap, 6–10 upper belt, 11–15 lower belt, 16–20 bottom cap.
- Fields are numbered row by row from the group's tip (the pole for cap groups, the pointed end for belt groups): 1 / 2 3 4 / 5 6 7 8 9.
- Fields 1, 5, 9 touch an icosahedron vertex: Typ 1 (60 panels). The rest are Typ 2 (120 panels).

After a draw, "Gruppe anzeigen" zooms onto the student's group and shows which of its fields are already taken (not by whom).

Open the page with `?labels` at the end of the URL to see every tile's face and sub-face number. Useful for checking against a physical model. The sphere can be dragged to turn it.

## 1. Try it locally (demo mode)

With `config.js` left empty, the page runs without a database. The test IDs are `1234567` and `7654321`.

```bash
cd tile-draw
python3 -m http.server 8000
```

Open http://localhost:8000. (Opening `index.html` directly as a file won't load the modules.)

## 2. Set up Supabase

1. Create a free account at supabase.com and a new project. Any region works; Frankfurt (eu-central-1) keeps the data in Germany.
2. Open **SQL Editor**, paste the contents of `supabase/setup.sql`, and click **Run**. If you ran an older version of the script, just run the new one again: it updates the codes and keeps existing assignments.
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

1. Create a new GitHub repository and upload the contents of the `tile-draw` folder (with `index.html` at the top level).
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`, and save.
3. After a minute the site is live at `https://<username>.github.io/<repository>/`.

Test it once with your own ID from the CSV, then reset that entry (see below).

## Managing the draw

Run these in the Supabase SQL Editor.

```sql
-- All assignments
select student_id, code, assigned_at from tiles
where student_id is not null order by assigned_at;

-- Free a student's tile so they can roll again
update tiles set student_id = null, assigned_at = null where student_id = '2412345';

-- Reset the whole draw
update tiles set student_id = null, assigned_at = null;

-- Add a late student
insert into students (student_id) values ('2412399');
```

To export the results, run the first query and use **Export → CSV** in the results panel.

## Good to know

- Free Supabase projects are paused after about a week without activity. Open the dashboard a day before the session and restore the project if needed.
- Anyone who knows a classmate's ID could roll for them. For a course this is usually fine; if not, the check could be extended with a second field (for example a short code you hand out).
- The draw happens on the server, so reloading the page or editing the JavaScript can't change a result.
