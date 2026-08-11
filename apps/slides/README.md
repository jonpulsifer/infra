# slides

Project decks, one directory each. Every deck is a single self-contained
`index.html` — no build step, no dependencies, no JavaScript — so the file in
git is byte-for-byte what gets served.

| Deck | Subject | Served at |
| --- | --- | --- |
| `spindrift/` | The deploy control plane in `apps/spindrift` | `spindrift-slides-web.web.app` |
| `bosun/` | The microVM CI runner pool in `apps/bosun` | `bosun-slides-web.web.app` |

They are one chart series printed with two plates: identical tokens, layout and
components, and a different accent per project. A change to one deck's shared
CSS belongs in the other.

## How they ship

Through Spindrift, as `website` Apps whose source is an uploaded archive: `POST`
the deck directory to `/internal/upload`, and the returned digest and location
become an `uploadArchive` Build that the ordinary build route turns into a
`files` artifact for the `bluenose/static` Target.

The upload boundary normalizes the container before anything durable happens: a
gzipped tar stages as-is, a ZIP is transcoded into one, and anything else is
refused with a `400` naming what arrived. Every build route opens a staged
bundle with `tar -xz`, so gzip is the wire format rather than a preference, and
the one conversion sits in front of the depot instead of in three fetchers —
`apps/spindrift/src/storage/archive-format.ts` carries the reasoning.

The digest describes the **converted** bytes, so a ZIP upload's `bundleDigest`
names the tarball the builders actually fetch, not the file that left this
machine.

A deck is therefore its own acceptance evidence — the deployed page is the
product describing itself — which is why the copy carries live digests, build
numbers and measurements rather than illustrative ones. Anything asserted on a
slide is traceable to the tree, `apps/bosun/README.md`, or a recorded live
observation.

## Site names are spent when they are used

A Firebase Hosting site id is permanently reserved once created, and deleting
the site does not give the name back. Never delete a Hosting site to reclaim
one; route a wanted address to the serving site instead.
