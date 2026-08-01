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
 * `sed`, `grep`, `base64`, `sha256sum`, `mktemp`, `uname`, and
 * `buildctl-daemonless.sh` on the path. Every one of those is in the stock
 * BuildKit image; a hardened replacement that drops one will fail loudly on the
 * first build rather than subtly on the hundredth.
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
   * The repository the artifact is pushed to, without a tag. Core chose it; the
   * route never does (§4).
   */
  readonly destination: string;
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
    destination: spec.destination,
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
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The railpack release whose plan generator matches the pinned frontend.
 *
 * The zero-config arm does not hand the frontend a `#syntax=` stub — the
 * railpack frontend reads its input as a **build plan** and answers a stub with
 * `invalid character '#' looking for beginning of value`. So the plan has to be
 * generated, and the generator is `railpack prepare`, whose output is
 * railpack's own serialisation format and is versioned with railpack.
 *
 * Generator and consumer must therefore be the same release, and the tag of the
 * pinned reference is what says which. Deriving it here keeps the installation
 * pinning **one** value: a second field naming the CLI version could drift from
 * the frontend it feeds, and — as ticket 29 found for this very field — a
 * manifest key with no authoring path is a value that can only ever be wrong
 * once. It does mean the arm assumes the pinned image *is* railpack, which is
 * the assumption §5's ladder already makes.
 *
 * `null` when the reference carries no tag to read: pinned by digest, or bare.
 * The caller turns that into a failure inside the zero-config arm rather than a
 * refusal to compose, so a scope **with** a Dockerfile still builds and the
 * message lands in the attempt log where an operator can see it.
 */
export function railpackVersion(zeroConfigFrontend: string): string | null {
  // A digest pin names bytes, and bytes do not carry a release number.
  if (zeroConfigFrontend.includes('@')) return null;
  const tag = zeroConfigFrontend.slice(zeroConfigFrontend.lastIndexOf(':') + 1);
  // No colon at all leaves the whole reference; a colon in the *registry* —
  // `localhost:5000/frontend` — leaves a path. Neither is a tag.
  if (tag === zeroConfigFrontend || tag.includes('/')) return null;
  return tag === '' ? null : tag;
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
  const refs = input.tags.map((tag) => `${input.destination}:${tag}`).join(',');
  return `"name=${refs}"`;
}

/**
 * The `else` of §5's ladder: fetch the plan generator, generate, hand it over.
 *
 * The generator is fetched rather than baked in so the stock BuildKit image
 * keeps working — the tools this needs (`wget`, `tar`, `uname`) are ones the
 * module already declares, and requiring a custom builder image to reach the
 * fallthrough arm would make "one engine, two frontends" cost an image build.
 * The binary and the plan land in separate directories because the second one
 * is mounted into the build, and a mount is a smaller promise when it holds
 * only what the frontend reads.
 *
 * A reference with no readable tag fails **here**, in the arm that needs it,
 * with the reason on stderr — not at compose time, which would take the
 * Dockerfile arm down with it and say so nowhere an operator looks.
 */
function zeroConfigArm(input: BuildKitProgramInput): string {
  const version = railpackVersion(input.zeroConfigFrontend);
  if (version === null) {
    const reason = `the zero-config frontend ${input.zeroConfigFrontend} carries no version tag, so the matching railpack plan generator cannot be resolved; pin it by tag`;
    return `  echo ${quote(reason)} >&2
  exit 1`;
  }

  // The architecture is the runner's to report, so the asset name is single
  // quoted either side of it: the version reaches a shell and quoting is what
  // keeps a manifest value from becoming an extra command, while `$arch` still
  // has to expand. Adjacent quoting concatenates, so each of these is one word.
  const release = `https://github.com/railwayapp/railpack/releases/download/${version}`;
  const prefix = `railpack-${version}-`;
  const suffix = '-unknown-linux-musl.tar.gz';

  return `  bin="$workspace/railpack-bin"
  plan="$workspace/railpack-plan"
  mkdir -p "$bin" "$plan"
  case $(uname -m) in
    x86_64) arch=x86_64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "railpack publishes no build for $(uname -m)" >&2; exit 1 ;;
  esac
  asset=${quote(prefix)}"$arch"${quote(suffix)}
  # The release publishes checksums, so the download is checked rather than
  # trusted: this binary reads the developer's source.
  wget -qO "$bin/$asset" ${quote(`${release}/`)}"$asset"
  wget -qO "$bin/checksums.txt" ${quote(`${release}/checksums.txt`)}
  (cd "$bin" && grep " $asset\\$" checksums.txt | sha256sum -c -)
  tar -xzf "$bin/$asset" -C "$bin" railpack
  "$bin"/railpack prepare . --plan-out "$plan/railpack-plan.json"
  set -- --frontend gateway.v0 --opt source=${quote(input.zeroConfigFrontend)} \\
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
ref=${quote(input.destination)}@"$digest"
report=$(printf '{"bundleDigest":"%s","digest":"%s","refs":["%s"],"baseDigest":null,"buildkitProvenanceRef":"%s","sbomRef":"%s"}' \\
  ${quote(input.bundleDigest)} "$digest" "$ref" "$ref" "$ref")
echo "${BUILD_REPORT_MARKER} $(printf '%s' "$report" | base64 | tr -d '\\n')"
`;
}
