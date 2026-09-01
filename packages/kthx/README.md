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
