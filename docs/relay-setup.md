# Dial relay: one-time setup

The relay is a ~150-line script (`relay/worker.js`) that runs for free on Cloudflare Workers.
It lets Dial show song info for stations the browser can't read directly (Radio Paradise, and
any station that puts the song title inside its audio stream). It only talks to hosts that appear
as station addresses in the live Dial page and only answers Dial's own page, so it is not an open
proxy.

## Set up (once, about 10 minutes; easier on a computer)

1. Make a free account at https://dash.cloudflare.com/sign-up (email only, no payment).
2. In the dashboard open **Workers & Pages** → **Create** → **Create Worker**.
3. Name it something like `dial-relay` and press **Deploy** (the default "Hello World" code is fine for now).
4. Press **Edit code**. Select everything in the editor, delete it, and paste the full contents of
   `relay/worker.js` from this repo. Press **Deploy**.
5. Copy the Worker's address. It looks like `https://dial-relay.<your-name>.workers.dev`.
6. Test it in a browser tab (use your own address):
   `https://dial-relay.<your-name>.workers.dev/icy?u=https://ice1.somafm.com/groovesalad-128-mp3`
   You should see JSON like `{"raw":"Artist - Title","artist":"Artist","title":"Title"}`.
7. Send the address to Claude. It goes into the single line `const RELAY_URL = '';` near the top of
   Dial's script in `index.html`. Until that line is filled in, the relay is simply off.

Cloudflare's dashboard wording changes now and then; if a button is named differently, look for
"create a Worker" and "edit code".

## Is it ongoing?

No. It runs by itself on the free plan (100,000 requests a day; Dial uses a few thousand at most).

Adding stations to Dial needs no change to the relay. It re-reads the published Dial page at most
every 10 minutes and allows whatever station hosts are listed there, so a new station works once
GitHub Pages has published it and the relay's list refreshes (allow about 10-15 minutes).

You only touch the Worker again if `relay/worker.js` itself changes (it did when Liked songs sync was added): paste the new version into
the same Worker and press Deploy. The two things hardcoded in it are the Dial page address
(`PAGE_URL`) and the extra JSON hosts (`api.radioparadise.com` and `api.radiofrance.fr`, in `JSON_HOSTS`). If the Dial
page ever moves to a new address, or you want another JSON source, those are what to edit.

## Turn on "Liked songs" sync (optional, one-time, about 5 minutes)

Dial's heart button and Liked songs list work without this, but only on the device that saved
them. To share the list between your phone and your computer, the relay needs somewhere to keep
it. Cloudflare's free KV storage does that.

1. In the Cloudflare dashboard open **Storage & databases** → **KV** → **Create a namespace**.
   Name it `dial-likes`.
2. Open your Worker (**Workers & Pages** → `dial-relay`) → **Settings** → **Bindings** →
   **Add** → **KV namespace**. Set the variable name to exactly `LIKES` and pick `dial-likes`.
   Save.
3. Paste the latest `relay/worker.js` into the Worker (**Edit code**) and press **Deploy**.
4. In Dial, tap the heart in the top bar → **Turn on sync**. It shows a code; on the other device
   open the same heart panel → **I have a code** and type it in.

How it works: the code is a random secret. Each device sends its list with the code; the relay
merges it with what it holds and sends the merged list back, so likes and removals reach every
device. Only a hash of the code is used as the storage key. Anyone who has the code can see and
change that list, so treat it like a password. A list nobody syncs for about 13 months is deleted.
Free-plan limits (1,000 writes a day) are far above normal use because the relay only writes when
the list actually changed.

If the panel says "Sync isn't set up on the relay yet", the `LIKES` binding or the new code is
missing (steps 2 and 3). Sync only works from the real Dial page, not from preview links.

## Limits

- Not every stream carries song titles. Some stations send nothing, or just their own name;
  Dial hides those.
- HLS streams (BBC, CBC, RTHK) have no embedded titles. BBC already has its own lookup.
- Non-standard ports (Soho Radio :8010, Blue Marlin :8001) may or may not be reachable from
  Cloudflare; check them on the phone.

## Troubleshooting a station that shows nothing

Add `&debug=1` to the test address to see what the station actually sends the relay, e.g.
`https://dial-relay.<your-name>.workers.dev/icy?debug=1&u=https://ice1.somafm.com/groovesalad-128-mp3`
The reply includes the upstream status, the stream's `icy-metaint` header (present only if the
station sends titles), the length of each metadata block, and a `stoppedBecause` reason.

To test every live station at once, run `python3 tools/check_relay.py https://your-worker.workers.dev`
(Python 3, no installs; add `--verbose` for the station response headers on failures). It prints one line per station: `TITLE` if the relay got a song title,
`NONE` with the reason if it didn't, `ERROR` if the relay itself couldn't be reached.

