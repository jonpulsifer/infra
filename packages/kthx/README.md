# @repo/kthx

The half of [kthx](../../docs/pages/Architecture___kthx.md) that has no runtime
behind it: the files a host serves as bytes, and the `/_/` contract `kthx dev`
answers.

| File | What it is |
| --- | --- |
| `landing.html` | the apex page, served at `https://kthx.dev/` |
| `sdk.js` | `window.kthx`, served at `/sdk.js` and every site's `/api/sdk.js` |
| `skill.md` | the agent reference, served at `/skill.md` and written by `kthx init` |
| `favicon.ts` | the generic icon a kthx host answers with when a bundle ships none |
| `assets.ts` | where the three files above are on disk, for a server that reads them |
| `underscore.ts` | the `/_/` key→JSON contract |

`apps/kthx` serves the assets from its own process, and answers `/_/` with 410
on every site host. `kthx dev` answers `/_/` over a `Map`, which is all a
`KthxStore` takes.

`landing.html` reads and does not write: a site is owned by a Google account, a
browser cannot mint the ID token an owner call needs, and the page says so
rather than offering a form that cannot work. It is the wordmark, the two
commands that start a site, the SDK, and the public directory with each site's
owner beside it.
