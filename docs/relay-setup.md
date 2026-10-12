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

You only touch the Worker again if `relay/worker.js` itself changes: paste the new version into
the same Worker and press Deploy. The two things hardcoded in it are the Dial page address
(`PAGE_URL`) and the one extra JSON host (`api.radioparadise.com`, in `JSON_HOSTS`). If the Dial
page ever moves to a new address, or you want another JSON source, those are what to edit.

## Limits

- Not every stream carries song titles. Some stations send nothing, or just their own name;
  Dial hides those.
- HLS streams (BBC, CBC, RTHK) have no embedded titles. BBC already has its own lookup.
- Non-standard ports (Soho Radio :8010, Blue Marlin :8001) may or may not be reachable from
  Cloudflare; check them on the phone.
