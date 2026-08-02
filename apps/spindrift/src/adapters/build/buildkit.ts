/**
 * The program every route runs (§4).
 *
 * §4 settles the engine and refuses to make it a per-route choice: "**BuildKit
 * with two frontends** — the repo's Dockerfile if present, else a zero-config
 * builder", and "because Railpack *is* a BuildKit frontend, 'Dockerfile if
 * present, else Railpack' is **not two build systems to operate** — it is one
 * engine with two frontends."
 *
 * This module is what makes that true rather than aspirational. The cloud
 * builder runs this in a build step, the cluster runs it in a Job, and hosted CI
 * runs the same two frontends over the same ladder — so a build that works on
 * one route is a build that works on the others, and the routes differ only in
 * *where* they run and what provenance they can claim.
 *
 * **The ladder runs here and not in core**, which is what the build contract
 * means by "the frontend is not here". A Dockerfile settles how to build and
 * never what the thing is (§5) — core already decided the `kind`, and this
 * script decides nothing except which frontend gets handed the same directory.
 *
 * **What the image must provide.** Declared, not discovered, so an installation
 * that pins an image knows what it is promising: a POSIX `sh`, `wget`, `tar`,
 * `sed`, `base64`, `chmod`, `mktemp`, and `buildctl-daemonless.sh` on the path.
 * Every one of those is in the stock BuildKit image; a hardened replacement that
 * drops one will fail loudly on the first build rather than subtly on the
 * hundredth.
 */
import type { BuildSource, BuildSpec } from './contract.ts';
import { BUILD_REPORT_MARKER } from './report.ts';

/** Everything the program needs to know, all of it already decided by core. */
export interface BuildKitProgramInput {
  /** Where the staged bundle is fetched from — a depot URL, opaque here. */
  readonly bundleUrl: string;
  /** §16's join, echoed back in the report so core can check it. */
  readonly bundleDigest: string;
  /** The scope inside the bundle, after §5's unwrap. */
  readonly subpath: string;
  /**
   * The repositories the artifact is pushed to, without tags. Core chose them;
   * the route never does (§4). One build, one digest, every destination.
   */
  readonly destinations: readonly string[];
  /** The tags to push it under (§12). Core chose these too. */
  readonly tags: readonly string[];
  /** The zero-config frontend the installation pinned. */
  readonly zeroConfigFrontend: string;
  /** §4: ordinary rows, never fetched from a store. */
  readonly buildArgs: BuildSpec['buildArgs'];
}

/**
 * The program for one build, from what the contract already carries.
 *
 * The two routes that run this in a container — the cloud builder and the
 * cluster Job — differ in *where* they run it and in nothing else, so composing
 * the input is here rather than twice over. §4's "one engine" is only true if
 * one place decides what the engine is told.
 *
 * The frontend is the exception: it is installation configuration rather than
 * anything the contract carries, so a route supplies it.
 */
export function buildKitProgramFor(
  source: BuildSource,
  spec: BuildSpec,
  zeroConfigFrontend: string,
): string {
  return buildKitProgram({
    // One expression for both origins, which is §4's "repo and archive share
    // one pipeline" made literal: the program never learns which it is
    // building, because by then the difference is only a principal on a
    // receipt (§16).
    bundleUrl: source.origin.location,
    bundleDigest: source.bundleDigest,
    subpath: source.origin.subpath,
    destinations: spec.destinations,
    tags: spec.tags,
    zeroConfigFrontend,
    buildArgs: spec.buildArgs,
  });
}

/**
 * Single-quote a value for `sh`.
 *
 * Every value below reaches a shell, and two of them — the destination and the
 * build arguments — carry developer-influenced text. Quoting is therefore not
 * tidiness: it is the boundary between a build argument and an extra command.
 */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `name=` field of the image exporter, carrying every tag (§12).
 *
 * The exporter takes one comma-separated list of full references, and its
 * options are themselves comma-separated — so the field is wrapped in the
 * double quotes buildctl's CSV parser reads, which is a different layer from
 * the single quotes {@link quote} puts around the whole option for `sh`. Both
 * are needed and neither substitutes for the other.
 */
function imageNames(input: BuildKitProgramInput): string {
  const refs = input.destinations
    .flatMap((destination) => input.tags.map((tag) => `${destination}:${tag}`))
    .join(',');
  return `"name=${refs}"`;
}

/**
 * The `else` of §5's ladder: take the plan generator out of the frontend image,
 * generate, hand it over.
 *
 * The railpack frontend reads its input as a **build plan** — a `#syntax=` stub
 * comes back as `invalid character '#' looking for beginning of value`, at every
 * version — so a plan has to be generated by `railpack prepare`. That output is
 * railpack's own serialisation format, versioned with railpack, so generator and
 * frontend must be one release.
 *
 * **The generator is already inside the frontend.** `ghcr.io/railwayapp/
 * railpack-frontend` is the whole railpack binary at `/railpack` with
 * `ENTRYPOINT ["/railpack", "frontend"]` — `frontend` is one subcommand of the
 * CLI that also carries `prepare`. So the release that reads the plan is
 * extracted from the image already pinned to read it, so "same release" is not a
 * thing to arrange: there is one artifact, and it cannot disagree with itself.
 *
 * A named context is how a file leaves an image without a registry client: the
 * dockerfile frontend resolves `docker-image://` itself, so this needs nothing
 * the stock BuildKit image does not already have, and the cluster fetches
 * nothing from github.com. The binary and the plan land in separate directories
 * because the second one is mounted into the build, and a mount is a smaller
 * promise when it holds only what the frontend reads.
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
    --local dockerfile="$plan"`;
}

/**
 * The `sh -c` program that turns a staged bundle into a pushed artifact.
 *
 * It ends by printing the report marker, because logs are read and never pushed
 * (§4) — there is no endpoint for it to report a digest to, so it reports on
 * the one channel core is already reading. `base64` output is folded by some
 * implementations and not others, hence the `tr`: a wrapped payload is a
 * payload core cannot decode.
 */
export function buildKitProgram(input: BuildKitProgramInput): string {
  const args = Object.entries(input.buildArgs)
    .map(([key, value]) => `  --opt ${quote(`build-arg:${key}=${value}`)} \\`)
    .join('\n');

  return `set -eu
workspace=$(mktemp -d)
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
if [ -f Dockerfile ]; then
  set -- --frontend dockerfile.v0 --local dockerfile=.
else
${zeroConfigArm(input)}
fi

buildctl-daemonless.sh build "$@" \\
  --local context=. \\
${args}
  --attest=type=provenance,mode=max \\
  --attest=type=sbom \\
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
