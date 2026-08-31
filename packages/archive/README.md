# @repo/archive

The bytes half of a deploy, with no app behind it: what an uploaded archive is
(`archive-format.ts`), what a bundle holds (`bundle.ts`), how a process with no
stored credential reaches a bucket (`federation.ts`,
`federation-credential.ts`, `gcs.ts`), and the base64url codec both sides of a
digest use (`bytes.ts`).

Two hosts stage and read the same gzipped tars out of the same GCS depot —
`apps/spindrift` for an App's source, `apps/kthx` for a site's release — and a
second copy of a tar writer, a ZIP transcoder or a token exchange is a second
place for them to disagree about what a staged bundle is.

What is deliberately **not** here: anything that names a §6 verdict, a
manifest, or a database. `bundleFailure` stays in
`apps/spindrift/src/adapters/deploy/static/bundle.ts` and `stageArchiveBytes`
stays in `apps/spindrift/src/storage/archives.ts` for that reason — both read
this app's contract, and a package that imported it would put Spindrift in
every host that installs this.
