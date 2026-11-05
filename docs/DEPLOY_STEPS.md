# Deploying and updating: the short, plain version

## The three pieces (and what each one is for)
| Piece | What it is | You touch it when |
|---|---|---|
| **GitHub** (repo `esbepe08/easv522`) | The folder of game files. Nothing runs here. | Every update: you upload the new files. |
| **Vercel** (project `easv522`) | Turns the repo into the website. It rebuilds **by itself** every time GitHub changes. | Almost never: only to set the two environment variables once. |
| **Supabase** (project `easv522mpo`) | The online brain: the database and the `eas-game` function that deals tiles and keeps the rules fair. | Only when a release says "database / server changed". |

Offline play needs only the website. Online play needs all three.

## Updating the game (the normal case)
1. Unzip the new release on your computer.
2. Open the GitHub repo → **Add file → Upload files**.
3. Drag everything that is **inside** the `eas-online` folder (not the folder itself). After the upload `index.html` must sit at the top level of the repo, next to `sw.js`.
4. Write a message ("v5.2.3") and **Commit changes** to `main`.
5. Open Vercel → the project → **Deployments**. Wait about a minute for **Ready**.
6. On every phone / computer: **close the game completely and open it again** (installed app: swipe it away). Until you do, the device keeps showing the old copy. Online play warns you when the two devices run different versions.

If a release also says **"server changed"** (new file in `supabase/migrations`, or `supabase/functions` changed), do these *before* step 4, in this order: run the new SQL file in Supabase (SQL editor, or ask Claude to apply it with the Supabase connector), then deploy the `eas-game` function. Release v5.2.2 needs nothing new.

## The two settings that must be right (once)
**Vercel → Settings → Environment Variables (Production)**
- `SUPABASE_URL`: `https://<your-project-ref>.supabase.co`
- `SUPABASE_ANON_KEY`: the **public** key (Supabase → Project Settings → API → anon / publishable). Since v5.2.3 the name `SUPABASE_API_KEY` is accepted too. **Never** paste the `service_role` / secret key: the build refuses it.

After changing a variable you must **redeploy** (Deployments → ⋯ → Redeploy), because the values are baked in at build time. The build log prints which names it found.

**Supabase → Authentication → Sign In / Providers → "Allow anonymous sign-ins": ON.** Without it online play cannot even start.

## Five-minute check after any deployment
1. Open `https://<your-site>/pwa-check.html`. Every line should be ✔ (a ⚠ about "not installed" is normal in a browser tab). It tests the install files, the Supabase address and key, and whether `eas-game` exists.
2. Two devices (or a phone and a private window): create a room on one, join with the code on the other, start, play one move. You should see the *who starts* draw on both.

## When something is wrong
| What you see | Most likely cause | Fix |
|---|---|---|
| Online button says "not enabled in this version" | Build had no URL/key (wrong variable name, or not set for **Production**) | Fix the variables, then **Redeploy** |
| "Anonymous sign-ins are disabled" | The switch above is off | Turn it on in Supabase |
| "Wrong key" | A different project's key, or the secret key | Copy the public key from this project |
| "Function eas-game is not deployed" | Function missing in this Supabase project | Deploy `eas-game` |
| "Database is not ready" | A migration is missing | Run the SQL files in order (…01 to …06) |
| Works on my phone, not on my friend's | His device still has the old copy | Close and reopen the game on that device |
| A button or feature "does nothing" | Same: old copy on one device | Same fix; the game now says when versions differ |
| Everything worked, now online fails | Supabase **free projects pause after a week of no use** | Supabase → Restore project |

## What Claude can do for you with the connectors
Check that migrations and the function are deployed, read error logs, list Vercel deployments and variables (it can see *names* but not secret values), rename a variable, and deploy the function. Changes to production only happen when you ask for them.
