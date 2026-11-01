# kthx

A directory becomes `https://<name>.kthx.dev`. Every site host also answers
`/api/*` with backends the server fronts with credentials the site never sees:
documents, realtime, an anonymous visitor id, an OpenAI-compatible model
endpoint, files, and MCP. There is no build step and no server to
run — a static bundle plus `window.kthx` is the whole application.

A site is the folder `<name>/` in a storage bucket, and `kthx deploy` writes it
with your own Google credentials. Its owner is the email those credentials
name. There is no rollback.

## Client

```html
<script src="/api/sdk.js"></script>
```

`window.kthx` is same-origin: it needs no key, no project id and no
configuration. On the apex the same bytes are at `/sdk.js`.

```js
await kthx.ready              // resolves after GET /api/me; only kthx.me and kthx.site wait on it
kthx.site                     // {name, url}
kthx.me                       // {id} — a signed anonymous id, stable per browser per site

const notes = kthx.db.collection("notes")
await notes.create({ title: "hi" })                  // → {id, created_at, updated_at, etag, title}
await notes.create([{ a: 1 }, { a: 2 }])             // ≤ 100 at once, all or nothing → {items}
await notes.get(id)                                  // → doc | null
await notes.update(id, { title: "new" })             // SHALLOW MERGE of top-level keys
await notes.update(id, doc, { overwrite: true })     // replace — the only way to drop a key
await notes.update(id, patch, { ifMatch: doc.etag }) // 412 on a concurrent write
await notes.put(id, doc, { ifNoneMatch: "*" })       // upsert; create-only with ifNoneMatch
await notes.delete(id)
await notes.list({ where: { done: false }, orderBy: "created_at desc", limit: 50 })
await notes.where({ done: false }).orderBy("title").limit(20).find()
await notes.count({ done: false })
const stop = notes.subscribe({ onCreate, onUpdate, onDelete })   // websocket; includes this tab's writes
await kthx.db.collections()                          // → [{name, count}]

const room = kthx.live.join("lobby")
room.send({ hello: true })
room.on("message", ({ from, data }) => {})
room.on("peers", (ids) => {})                        // fires on join and after every reconnect
room.on("join", (id) => {}); room.on("leave", (id) => {})
room.peers(); room.leave()

await kthx.ai.chat("summarise this")                 // → string
for await (const delta of await kthx.ai.chat(msgs, { stream: true })) {}
kthx.ai.baseURL                                      // absolute; hand it to the OpenAI SDK

await kthx.files.upload("cover.png", file)           // → {path, url, size, type}
kthx.files.url("cover.png")
await kthx.files.list()
await kthx.files.delete("cover.png")
```

Every rejection is an `Error` with `.code`, `.status`, `.message` and, on a 429,
`.retryAfter` in seconds. The socket opens on the first `subscribe`/`join`,
re-subscribes on reconnect, and pings every 30 s.

With the OpenAI SDK:

```js
const openai = new OpenAI({
  baseURL: kthx.ai.baseURL,      // absolute — a relative baseURL throws at request time
  apiKey: "kthx",                // any non-empty string; the server ignores it
  dangerouslyAllowBrowser: true,
})
```

## Documents

A document is a JSON object. Four keys are the server's: `id`, `created_at`,
`updated_at`, `etag`. `id` may be supplied on create; the rest are always
replaced. `etag` is opaque, and `ifMatch` is how two writers avoid clobbering
each other — a mismatch is 412.

`update` merges top-level keys. A nested object or array in the patch replaces
the stored one whole; `null` is stored as a value, not a deletion. `overwrite`
or `put` replaces the document.

Query `where` is an object of field paths to values or one operator each, ANDed:

```
{ done: false, score: { $gte: 10 }, tag: { $in: ["a", "b"] } }
```

Paths are `id`, `created_at`, `updated_at`, or a dotted path into the document
(`author.name`), ≤ 8 segments. Operators: `$gt $gte $lt $lte $ne $in $nin $like
$ilike $exists`. There is no `$or`. `orderBy` is `"<path>"` or `"<path> desc"`,
default `"created_at desc"`. `limit` defaults to 100 and clamps at 500;
`offset` goes to 10 000.

## HTTP

The SDK is a convenience; the routes are the product. `<site>` is
`https://<name>.kthx.dev`.

| Method | Path | Answers |
| --- | --- | --- |
| GET | `/api` | `{name, url, docs}` |
| GET | `/api/me` | `{id, site}` — sets the visitor cookie |
| GET | `/api/db` | `{collections: [{name, count}]}` |
| GET | `/api/db/:collection` | `{items}`; query `where`, `orderBy`, `limit`, `offset` |
| POST | `/api/db/:collection/query` | `{items}` or `{items, count}` with `count: true` |
| POST | `/api/db/:collection` | the document, or an array of ≤ 100 |
| GET | `/api/db/:collection/:id` | the document |
| PATCH | `/api/db/:collection/:id` | shallow merge; `?overwrite=1`; `If-Match` |
| PUT | `/api/db/:collection/:id` | upsert; `If-Match` / `If-None-Match: *` |
| DELETE | `/api/db/:collection/:id` | 204 |
| DELETE | `/api/db/:collection` | 204 — owner only; drops every document |
| GET | `/api/ws` | websocket |
| POST | `/api/ai/v1/chat/completions` | OpenAI-compatible; also `/models`. `/v1` is optional; nothing else under `/api/ai` exists |
| GET | `/api/ai/usage` | `{day, requests, tokens, quotas}` — today, against the daily budget |
| PUT | `/api/files/<path>` | `{path, url, size, type}` |
| GET | `/api/files` | `{items}` |
| DELETE | `/api/files/<path>` | 204 |
| GET | `/files/<path>` | the bytes |
| POST | `/api/mcp` | JSON-RPC 2.0, one message per request |

The apex has one route no token opens: `GET https://kthx.dev/api/sites` is the
public directory — `{items: [{name, url, owner, deployed}], next}`, newest
deploy first, `limit` up to 500 and `after=<name>` for the page after that.
`owner` is an address only when the caller is that site's owner, and `null`
to everyone else. Ask for more than sixty pages a minute from one address and
the answer is 429 `RATE_LIMITED`.

| Method | Path | Answers |
| --- | --- | --- |
| GET | `/api/names/:name` | `{available, why, yours}` — whether a name is free to claim |
| GET | `/api/whoami` | `{login}` for a tailnet login or a verified ID token, else 401 |
| GET | `/api/sites?owner=me` | the directory, narrowed to the caller's own sites |
| GET | `/api/sites/:name` | owner only: `{owner, deployed, usage, quotas}` |
| DELETE | `/api/sites/:name` | owner only: deletes the folder, the database and the files; the name is free |

The owner is the email on the site's marker. A request opens a site as its
owner with `Authorization: Bearer <Google ID token>` whose email is that one —
`gcloud auth print-identity-token` prints one — or, on the tailnet host, with
the tailnet login a proxy vouches for.

Every non-`GET` `/api/*` from a browser must send `Origin` equal to the site's
own; a non-browser client sends none. JSON routes require `content-type:
application/json`. Errors are `{code, message}` with `x-request-id` on the
response — quote that id when asking why.

Websocket frames:

```
c→s  {t:"sub",collection} {t:"unsub",collection}
     {t:"join",room} {t:"leave",room} {t:"send",room,data} {t:"ping"}
s→c  {t:"create"|"update",collection,id,etag,doc?} {t:"delete",collection,id}
     {t:"msg",room,from,data} {t:"join"|"leave",room,peer} {t:"peers",room,peers:[id]}
     {t:"pong"}
```

## Site files

A deploy is the directory: every file but dotfiles, `node_modules` and
`kthx.json`, with `index.html` at its root; a lone wrapping directory is the
root. Resolution: the exact file, then `<path>/index.html`, then the site's
`/404.html` (served 404). `/api/` and `/files/` are the server's on every site
— a deployed file under either is never served. A deploy shows within about
ten seconds, and is not atomic: HTML uploads last, after the files it names.

## The file store

`/files/*` is the site's own store, separate from its deployed files. Anyone on the
site may `PUT` a file; the path then belongs to that visitor, and only they or
the site's owner may overwrite or delete it (else 403). `content-type` is
required and is the stored type — nothing sniffs the bytes. Allowed:
`image/*` except SVG, `audio/*`, `video/*`, `application/pdf`,
`application/json`, `text/plain`, `text/csv`, `text/markdown`. Everything else,
HTML and script above all, is 400 `UNSUPPORTED_TYPE`: a file is never a page on
this origin. A path is `A-Za-z0-9._-` in `/`-separated segments, none starting
with a dot. Served with the stored type, `nosniff`, a strong etag and
`max-age=60`; anything not meant to be rendered comes back as an attachment.

## Limits

| What | Limit |
| --- | --- |
| deploy | 32 MiB, 2000 files |
| document | 1 MiB, nesting 32, 10 000 keys; request body 2 MiB; bulk create 100 |
| site database | 256 MiB, 256 collections |
| query | 500 items, 16 `where` clauses, `$in` of 100, `offset` 10 000 |
| files | 25 MiB each, 256 MiB and 1000 files per site |
| AI | 200 requests or 500 000 tokens per site per UTC day |
| writes | 60/min per visitor, 240/min per address, 600/min per site |
| websocket | 16 KiB frames, 32 rooms and 32 subscriptions per socket, 8 sockets per visitor |

Reads are unmetered.

## Error codes

`INVALID_NAME` `RESERVED` `INVALID_COLLECTION` `INVALID_ID` `INVALID_DOCUMENT`
`INVALID_QUERY` `INVALID_PATH` `UNSUPPORTED_TYPE` `INVALID_MODEL`
`MALFORMED_REQUEST` (400) · `UNAUTHENTICATED` (401) · `FORBIDDEN`
(403) · `NOT_FOUND` (404) · `METHOD_NOT_ALLOWED` (405) · `TIMEOUT` (408) ·
`TAKEN` `EXISTS` (409) · `GONE` (410) · `PRECONDITION_FAILED` (412) ·
`TOO_LARGE` (413) · `RATE_LIMITED` `AI_BUDGET` (429) · `STORAGE_FAILURE` (500) ·
`AI_UPSTREAM` (502) · `BUSY` (503) · `SITE_FULL` (507)

## Command line

```
bun add -g https://kthx.dev/cli/kthx.tgz
gcloud auth application-default login
```

| Command | Does |
| --- | --- |
| `kthx init [dir]` | claims a name, writes `kthx.json` and this file |
| `kthx deploy [dir]` | syncs the directory to the site: uploads what changed, deletes what is gone |
| `kthx dev [dir]` | serves the directory on `:4321` against the site's live `/api` |
| `kthx ls` | the site's owner, last deploy and usage; with no `kthx.json`, every site you own |
| `kthx ls --all` | the public directory: every site on the apex |
| `kthx rm` | deletes the site and frees the name |
| `kthx open` | opens `https://<name>.kthx.dev` |
| `kthx upgrade` | replaces this copy with the one the apex serves |

The CLI reads Google Application Default Credentials: a gcloud user's, or a
workload's `external_account` file in `GOOGLE_APPLICATION_CREDENTIALS`. A claim
is a marker, `<name>/.kthx`, written only if absent. Ownership is a courtesy:
deploying over or deleting a site someone else owns asks first, and with no
terminal it refuses unless you pass `--force`. A deploy that races another
fails with `RACED`; deploy again. `kthx.json` holds `{name}` and nothing secret.

`kthx upgrade` re-runs `bun add -g` on the apex tarball. It replaces only a
`bun add -g` install. `kthx --version` prints the version and the build id; set
`KTHX_NO_UPDATE_CHECK=1` to stop the daily check for a newer one, and `NO_COLOR`
to turn the colour off.

## MCP

An editor that speaks Streamable HTTP with headers connects to
`https://<name>.kthx.dev/api/mcp` with `Authorization: Bearer <token>`, a
Google ID token for the site's owner from `gcloud auth print-identity-token`. Tools: `site_info`, `db_collections`,
`db_query`, `db_get`, `db_create`, `db_update`, `db_delete`.

## Owning a site

The owner's ID token is required by `/api/sites/:name` on the apex, by `DELETE
/api/db/:collection`, and by `/api/mcp`. Everywhere else a bearer that does not
open this site is ignored and the caller proceeds as a visitor. Writes default to
anyone on the site's own origin, bounded by the quotas above — a kthx link is
meant to be sendable to anyone.
