/**
 * The BuildKit shell program the container routes run: fetch the staged bundle,
 * build it with the repo's Dockerfile or the zero-config frontend, push, report.
 */
import type { RegistryAuth } from '../../storage/registry-credentials.ts';
import type { BuildSecretValue, BuildSource, BuildSpec } from './contract.ts';
import { BUILD_REPORT_MARKER } from './report.ts';

/**
 * The variable the program reads a Docker config from. The program text is
 * readable on the Job or build resource, so secrets travel only in the
 * environment and the program never uses `set -x`.
 */
export const REGISTRY_AUTH_VAR = 'SPINDRIFT_REGISTRY_AUTH';

/** One variable per build secret: the image has no `jq` to split a JSON blob. */
export const BUILD_SECRET_VAR_PREFIX = 'SPINDRIFT_BUILD_SECRET_';

export function buildSecretEnvOf(
  secrets: readonly BuildSecretValue[],
): Record<string, string> {
  return Object.fromEntries(
    secrets.map((secret) => [
      `${BUILD_SECRET_VAR_PREFIX}${secret.name}`,
      secret.value,
    ]),
  );
}

/**
 * A Docker config for `buildctl`, each `auth` being `base64(username:secret)`.
 * `null` for no credentials, so the route sets no variable at all.
 */
export function dockerConfigFor(auth: readonly RegistryAuth[]): string | null {
  if (auth.length === 0) return null;
  return JSON.stringify({
    auths: Object.fromEntries(
      auth.map((one) => [
        configKeyFor(one.host),
        { auth: btoa(`${one.username}:${one.secret}`) },
      ]),
    ),
  });
}

const DOCKER_HUB_CONFIG_KEY = 'https://index.docker.io/v1/';

/**
 * BuildKit looks Docker Hub credentials up under the legacy index URL. An entry
 * under either hostname is never read, and the push fails as access denied.
 */
function configKeyFor(host: string): string {
  return host === 'docker.io' || host === 'registry-1.docker.io'
    ? DOCKER_HUB_CONFIG_KEY
    : host;
}

export interface BuildKitProgramInput {
  readonly bundleUrl: string;
  /** Echoed back in the report so core can check it. */
  readonly bundleDigest: string;
  /** The scope inside the bundle, after unwrapping a lone top-level directory. */
  readonly subpath: string;
  readonly destinations: readonly string[];
  readonly tags: readonly string[];
  readonly zeroConfigFrontend: string;
  readonly buildArgs: BuildSpec['buildArgs'];
  /**
   * Names only, because this input becomes program text. The values travel in
   * the variables {@link buildSecretEnvOf} sets.
   */
  readonly buildSecretNames: readonly string[];
}

export function buildKitProgramFor(
  source: BuildSource,
  spec: BuildSpec,
  zeroConfigFrontend: string,
): string {
  return buildKitProgram({
    bundleUrl: source.origin.location,
    bundleDigest: source.bundleDigest,
    subpath: source.origin.subpath,
    destinations: spec.destinations,
    tags: spec.tags,
    zeroConfigFrontend,
    buildArgs: spec.buildArgs,
    buildSecretNames: spec.buildSecrets.map((secret) => secret.name),
  });
}

/**
 * Single-quote a value for `sh`. Destinations and build arguments carry
 * developer-supplied text, so this is the shell-injection boundary.
 */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The hosted build workflow carries this function verbatim, which a test checks,
 * and `domain/detection/dockerfile-context.ts` mirrors it. POSIX `sh` only: the
 * BuildKit image promises no other shell. Call it in a command substitution so
 * its `set --` stays off the caller's arguments.
 */
export const DOCKERFILE_CONTEXT_PROBE = `# Which directory this Dockerfile builds from: prints its own directory when
# a COPY/ADD source resolves beside it and not at the root, else the root.
spindrift_dockerfile_context() {
  sdc_file="$1"; sdc_root="$2"; sdc_scope="$3"
  sdc_context="$sdc_root"
  set -f
  while IFS= read -r sdc_line || [ -n "$sdc_line" ]; do
    set -- $sdc_line
    case "\${1:-}" in
      [Cc][Oo][Pp][Yy]|[Aa][Dd][Dd]) shift ;;
      *) continue ;;
    esac
    sdc_stage=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --from=*) sdc_stage=1; shift ;;
        --*) shift ;;
        *) break ;;
      esac
    done
    if [ "$sdc_stage" -eq 1 ]; then continue; fi
    while [ "$#" -gt 1 ]; do
      case "$1" in
        .|/*|*:*|*'*'*|*'?'*|*'['*|*..*) ;;
        *)
          sdc_source="\${1#./}"
          if [ -e "$sdc_scope/$sdc_source" ] && [ ! -e "$sdc_root/$sdc_source" ]; then
            sdc_context="$sdc_scope"
          fi
          ;;
      esac
      shift
    done
  done < "$sdc_file"
  set +f
  printf '%s\\n' "$sdc_context"
}`;

/**
 * The exporter's `name=` option with every tag. The double quotes are for
 * buildctl's CSV option parser; {@link quote} adds the shell layer around it.
 */
function imageNames(input: BuildKitProgramInput): string {
  const refs = input.destinations
    .flatMap((destination) => input.tags.map((tag) => `${destination}:${tag}`))
    .join(',');
  return `"name=${refs}"`;
}

/**
 * The railpack frontend reads a plan from `railpack prepare`. The generator is
 * copied out of the pinned frontend image through a named context, so the plan
 * and the frontend always come from one release.
 */
function zeroConfigArm(input: BuildKitProgramInput): string {
  const frontend = quote(input.zeroConfigFrontend);
  return `  bin="$workspace/railpack-bin"
  plan="$workspace/railpack-plan"
  gen="$workspace/railpack-gen"
  mkdir -p "$bin" "$plan" "$gen"
  # \`FROM scratch\` so the export is the one file, not a root filesystem.
  printf 'FROM scratch\\nCOPY --from=railpack /railpack /railpack\\n' > "$gen/Dockerfile"
  buildctl-daemonless.sh build --frontend dockerfile.v0 \\
    --opt context:railpack=docker-image://${frontend} \\
    --local context="$gen" --local dockerfile="$gen" \\
    --output type=local,dest="$bin"
  # The local exporter preserves the mode it copied, but a generator that lands
  # without its exec bit fails as "not found" and names nothing useful.
  chmod +x "$bin/railpack"
  "$bin"/railpack prepare . --plan-out "$plan/railpack-plan.json"
  set -- --frontend gateway.v0 --opt source=${frontend} \\
    --local dockerfile="$plan" --local context=.`;
}

/**
 * The `sh -c` program. The image must provide `sh`, `wget`, `tar`, `ls`, `wc`,
 * `mkdir`, `chmod`, `mktemp`, `sed`, `base64`, `tr` and `buildctl-daemonless.sh`.
 * Some `base64` builds fold long lines, hence the `tr` on the report.
 */
export function buildKitProgram(input: BuildKitProgramInput): string {
  // Each entry is a complete line with its newline, so an empty set adds nothing: a
  // blank line would end the `\` continuation and run the next flag as a command.
  const args = Object.entries(input.buildArgs)
    .map(([key, value]) => `  --opt ${quote(`build-arg:${key}=${value}`)} \\\n`)
    .join('');

  // One `--secret` line per name, like the build args above.
  const secretFlags = input.buildSecretNames
    .map(
      (name) =>
        `  --secret id=${quote(name)},src="$secrets_dir"/${quote(name)} \\\n`,
    )
    .join('');

  // `buildctl` reads a secret from a file. Each variable is unset once its file
  // exists, so the engine starts with no secret in its environment.
  const secretSetup =
    input.buildSecretNames.length === 0
      ? ''
      : `
# Build secrets (story 112). Each rode the container's environment under its
# own variable — never this program's text — and moves to a file only the
# named mount reads: available to the RUN that asks, absent from every layer,
# the log, and the pushed artifact.
secrets_dir=$(mktemp -d)
${input.buildSecretNames
  .map(
    (name) =>
      `printf '%s' "$${BUILD_SECRET_VAR_PREFIX}${name}" > "$secrets_dir"/${quote(name)}\nunset ${BUILD_SECRET_VAR_PREFIX}${name}`,
  )
  .join('\n')}
`;

  // The cache is one `buildcache` tag on the first destination, overwritten by
  // each build. `mode=max` caches every stage; a first build logs a harmless miss.
  const cacheRef = `${input.destinations[0] ?? ''}:buildcache`;

  return `set -eu
workspace=$(mktemp -d)

# The registry credentials, if this installation holds any for the destinations
# below. The variable carries the whole Docker config document rather than a
# token, so this program never has to know a username from a secret — it moves
# an opaque blob from the environment to the path buildctl reads and unsets it.
#
# \`DOCKER_CONFIG\` is a directory, not a file. Pointing it at the workspace
# would put credentials beside the build context; its own directory, created
# with the default umask inside a container this build owns, is as narrow as
# this gets without a mounted Secret.
if [ -n "\${${REGISTRY_AUTH_VAR}:-}" ]; then
  DOCKER_CONFIG=$(mktemp -d)
  export DOCKER_CONFIG
  printf '%s' "$${REGISTRY_AUTH_VAR}" > "$DOCKER_CONFIG/config.json"
  unset ${REGISTRY_AUTH_VAR}
fi
${secretSetup}
wget -qO- ${quote(input.bundleUrl)} | tar -xz -C "$workspace"

# §5's unwrap. The subpath is relative to the source root, and a bundle's root
# is not always that — a repository tarball wraps the tree in one directory.
# The rule is the shape rather than the source: exactly one entry and it a
# directory, which is what \`archiveScope\` applies to the copy core detects
# against. \`ls -A\` counts dotfiles, because a lone directory beside a stray
# \`.gitignore\` is two entries and unwrapping it would lose the file.
root="$workspace"
if [ "$(ls -A "$workspace" | wc -l)" -eq 1 ]; then
  only="$workspace/$(ls -A "$workspace")"
  if [ -d "$only" ]; then
    root="$only"
  fi
fi
cd "$root"/${quote(input.subpath)}

# §5's ladder, and the only decision this script makes: a Dockerfile settles
# how to build. What the thing *is* was decided before the build was dispatched.
#
# The zero-config arm generates a plan and hands it over on the \`dockerfile\`
# local — that is the mount name the frontend reads, and \`railpack-plan.json\`
# is the filename it defaults to. It is not a Dockerfile and it carries no
# syntax directive: the frontend parses this file as JSON.
#
# The two arms carry their own \`context\` local rather than sharing one below,
# because they do not agree on it and the disagreement is the point.
#
# The scope names the Dockerfile; the Dockerfile names its context. A monorepo
# App's Dockerfile is written against the root that \`docker build -f
# apps/x/Dockerfile .\` gives it — \`COPY . .\` then a path *into* the app —
# while a standalone repository's Dockerfile is written against its own
# directory, and keeps that shape when the repository is vendored under a
# subpath. Handing either kind the other's context fails deep inside the build
# with a missing path rather than here with a reason, so the probe reads the
# file's own COPY/ADD sources and keeps the root unless one resolves only
# beside the Dockerfile.
#
# The zero-config arm keeps the scope, because railpack detects a single app
# and a plan built against the root would describe the wrong one.
${DOCKERFILE_CONTEXT_PROBE}
if [ -f Dockerfile ]; then
  set -- --frontend dockerfile.v0 --local dockerfile=. \\
    --local context="$(spindrift_dockerfile_context Dockerfile "$root" .)"
else
${zeroConfigArm(input)}
fi

# Attestations are frontend options here, not flags. \`--attest=type=…\` is
# buildx's spelling; \`buildctl build\` has no such flag and refuses the whole
# invocation with \`Incorrect Usage: flag provided but not defined: -attest\`.
buildctl-daemonless.sh build "$@" \\
${args}${secretFlags}  --opt attest:provenance=mode=max \\
  --opt attest:sbom= \\
  --export-cache ${quote(`type=registry,ref=${cacheRef},mode=max`)} \\
  --import-cache ${quote(`type=registry,ref=${cacheRef}`)} \\
  --output ${quote(`type=image,${imageNames(input)},push=true`)} \\
  --metadata-file "$workspace/metadata.json"

digest=$(sed -n 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$workspace/metadata.json")
# One digest, one reference per destination — the same manifest was pushed to
# each, so the only thing that differs is the repository in front of the "@".
# The first is what the provenance and SBOM are reported against, because those
# are one document about one build rather than one per registry.
refs=""
for destination in ${input.destinations.map(quote).join(' ')}; do
  refs="\${refs:+$refs,}\\"\${destination}@\${digest}\\""
done
ref=${quote(input.destinations[0] ?? '')}@"$digest"
report=$(printf '{"bundleDigest":"%s","digest":"%s","refs":[%s],"baseDigest":null,"buildkitProvenanceRef":"%s","sbomRef":"%s"}' \\
  ${quote(input.bundleDigest)} "$digest" "$refs" "$ref" "$ref")
echo "${BUILD_REPORT_MARKER} $(printf '%s' "$report" | base64 | tr -d '\\n')"
`;
}
