# @repo/mate-hands

mate-hands is the tool daemon in a [mate](../../docs/apps/mate/how-it-works.md) sandbox. mate starts it over one `pods/exec` stream and sends it newline-delimited JSON calls: the file and shell methods of pi-agent-core's `ExecutionEnv`, and `hello`, `ping`, `cancel` and `shutdown`. `src/protocol.ts` holds the wire types both sides import, and `apps/mate/src/hands.ts` is mate's client. mate does not use it yet.

A daemon kills every process group it started, and exits, on stdin EOF, on `shutdown`, or when no message arrives within `--watchdog-ms`. It records those groups under `--state-dir`, so a daemon started with a newer `--epoch` kills what an older one left. Reads stop at `--max-read-bytes`, and every buffer has a limit, listed in the `hello` answer.

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
