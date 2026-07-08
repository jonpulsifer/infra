tags:: contributing

- Use this when vendoring an external `jonpulsifer` repo into this monorepo while preserving history.
- # Pick the destination
	- Deployable first-party service: `apps/<name>/`
	- Reusable library or chart: `packages/<name>/`
	- Base or tool OCI image: `images/<name>/`
- # Find existing consumers
	- Grep first. Rewiring consumers is often the larger part of the work:
	- ```bash
	  rg -n "<repo-name>|github:jonpulsifer/<repo-name>|jonpulsifer/<repo-name>"
	  ```
- # Merge with history
	- Work on a branch:
	- ```bash
	  git switch -c onboard/<name>
	  ```
	- Clone the source repo and rewrite its history into the destination directory:
	- ```bash
	  repo=<name>
	  dest=apps/$repo
	  rm -rf "/tmp/$repo"
	  gh repo clone "jonpulsifer/$repo" "/tmp/$repo" -- -q
	  branch="$(git -C /tmp/$repo branch --show-current)"
	  ( cd "/tmp/$repo" && nix run nixpkgs#git-filter-repo -- --to-subdirectory-filter "$dest" )
	  git remote add "temp-$repo" "/tmp/$repo"
	  git fetch -q "temp-$repo"
	  git merge "temp-$repo/$branch" --allow-unrelated-histories -m "Merge $repo into $dest"
	  git remote remove "temp-$repo"
	  rm -rf "/tmp/$repo"
	  ```
	- Merge the PR as a merge commit, not squash, so the preserved subtree history remains useful.
- # Remove dead vendored config
	- GitHub workflows and Renovate config inside the vendored directory are inert in this monorepo. Remove them unless there is content to port to root-level config:
	- ```bash
	  git rm -r apps/<name>/.github
	  git rm apps/<name>/renovate.json
	  ```
	- For Go apps now built by the monorepo flake, remove nested `flake.nix` and `flake.lock` after replacing their behavior at the root.
- # Rewire consumers
	- Container images: update `.github/workflows/containers.yml` matrix entries and watch paths.
	- Deploy workflows: recreate root workflows under `.github/workflows/<name>.yml` with paths and working directories pointed at the vendored location.
	- Nix-consumed Go programs:
		- Remove the old flake input.
		- Add `apps/<name>/package.nix`.
		- Add an overlay under `nix/overlays/`.
		- Update host modules to import the vendored module or package.
		- Build once to confirm the correct `vendorHash`.
- # Validate
	- Build the Nix package or host that consumes it.
	- Compile Go apps where relevant:
	- ```bash
	  CGO_ENABLED=0 go -C apps/<name> build ./...
	  ```
	- Confirm no old external references remain:
	- ```bash
	  rg -n "inputs\\.<name>|github:jonpulsifer/<name>|jonpulsifer/<name>"
	  ```
- # After merge
	- Offer to archive the now-vendored source repo after the monorepo PR lands.
	- Call out any deploy-time behavior changes in the PR, especially URL or runtime generation changes.
