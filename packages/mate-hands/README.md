# @repo/mate-hands

mate-hands is the tool daemon in a [mate](../../docs/apps/mate/how-it-works.md) sandbox. mate starts it over one `pods/exec` stream and sends it newline-delimited JSON calls: the file and shell methods of pi-agent-core's `ExecutionEnv`, `writeFiles`, and `hello`, `ping`, `cancel` and `shutdown`. `src/protocol.ts` holds the wire types both sides import, and `apps/mate/src/hands.ts` is mate's client. mate does not use it yet.

A daemon kills every process group it started, and exits, on stdin EOF, on `shutdown`, or when no message arrives within `--watchdog-ms`, 30 seconds by default. The client pings every third of that window. Reads stop at `--max-read-bytes`, and every buffer has a limit, listed in the `hello` answer.

## Epochs

A daemon records its process groups under `--state-dir`, so a daemon started with a newer `--epoch` kills what an older one left. A record with an epoch at or above a new daemon's supersedes it only while the process that wrote it lives. The new daemon kills a dead one's groups and removes its record, whatever its epoch, and removes a record not named for its own epoch and pid. A `superseded` error carries the highest live `epoch`, which `HandsError.ownerEpoch` reads, so a client can start its next daemon past it.

The client refuses a daemon whose `hello` names another `PROTOCOL_VERSION`, so a sandbox built from an older image fails to connect with `mismatch`.

## Files

Reads and writes open only regular files. Each call opens its path without blocking and checks the file it opened, so a FIFO, a socket, a device, or a symlink to one is refused with `invalid` and cannot hold the daemon. `exists` and `fileInfo` answer as pi's `NodeExecutionEnv` does: a FIFO, a socket or a device is an `invalid` "Unsupported file type", and a symlink to one is a `symlink`.

`writeFiles` writes credential files. It writes each file to a new temp file beside its path, sets its `mode` whatever the umask, syncs it, and renames it over the path, so a symlink there is replaced and not followed. Missing parents get `dirMode`, 0700 by default, and existing ones keep their mode. Empty content leaves an empty file. Files are written in order: a failure names its path, and the files before it stay written. The call is one request, so `maxRequestBytes` bounds it.

## Develop

```bash
bun run --cwd packages/mate-hands test
bun run --cwd packages/mate-hands typecheck
bun run --cwd packages/mate-hands lint
bun run --cwd packages/mate-hands compile
```

The tests start the daemon from source over pipes. `compile` writes the single binary to `dist/mate-hands`.

## Deploy

The package has no manifests of its own. The `images/mate-sandbox` image compiles it with `bun build --compile` and installs it at `/usr/local/bin/mate-hands`. The `apps/mate` image copies `src/` for the protocol module.
