# Dial (Radio-vb-)

Single-file web radio app (`index.html`) served by GitHub Pages from `main`. The song-title relay lives in `relay/`.

## Preview before merging

After every push to a working branch, finish your reply with a test link so the change can be tried on a phone before anything is merged. Build it from the full commit SHA of what you just pushed (`git rev-parse HEAD`), not the branch name, so it is never a stale cached copy:

    https://raw.githack.com/6m7cvk2vj5-del/Radio-vb-/<full-commit-sha>/index.html

- Give the link every time you push, not only when asked.
- Do not open a PR or merge until the user has asked; they use the preview to decide.
- Known limits of the preview: the relay only accepts requests from the real Pages origin, so song titles/artwork from the relay (Radio Paradise, FIP tracks, SomaFM and other stream titles) will not show. Playback, reconnects and layout can all be checked.
- Mention that the link was not opened from the sandbox (outbound access is limited there), so it is untested until the user loads it.

## Stash (Casey's workflow library: repo `6m7cvk2vj5-del/stash`)
Before you do any of these, check stash `INDEX.md` for a playbook, and read only the matching row:
starting a project or restructuring this CLAUDE.md · launching more than one session, worker or scheduled task · setting up a
branch/merge workflow · asking Casey questions (survey page) · verifying numbers a second way · giving Casey a preview link ·
hitting or planning around a usage limit · filing uploads/reference docs.
If stash is not attached, call `add_repo` (owner `6m7cvk2vj5-del`, repo `stash`, `access: "push"`) and then read it.
If stash has no row for what you need, follow its CLAUDE.md gap rule (log a `REQUESTED` row), tell Casey, and carry on.
When you learn something a future project would want, add one line to stash `LESSONS.md`.
