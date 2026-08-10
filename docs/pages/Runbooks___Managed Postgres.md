tags:: runbook, kubernetes, postgres, cnpg

- Every Postgres in the fleet is a CloudNativePG `Cluster`. Use the operator's own `kubectl cnpg` plugin rather than reconstructing what it does out of `kubectl exec`. The GitOps rules on [[Runbooks/Kubernetes GitOps Change]] apply here too: desired state is authored in git, and everything below is inspection.
- # The rule
	- **Reach a database through `kubectl cnpg`, never through a pod name.**
	- ```bash
	  kubectl --context folly cnpg psql tronbyt -n tronbyt
	  ```
	- The plugin resolves the primary itself. A hand-written `exec <cluster>-1` names a pod that is only the primary *until the next failover*, so it is right until the moment it matters most. It also needs `-c postgres` to skip the bootstrap init container, which is the kind of detail the plugin exists to know.
	- Same rule for the rest of the verbs — prefer the native tool over an equivalent assembled by hand.
- # Where the databases are
	- The operator is declared once for both clusters under `clusters/base/platform/cloudnative-pg/`. The `Cluster` objects themselves live with the app that owns them, in `clusters/` or in a chart under `packages/charts/`.
	- One set is not authored in git: a `Cluster` in `spindrift-apps` is a Datastore Spindrift provisioned through the cluster API, and the row in its database is the desired state. Inspect it like any other; change it through the product. See [[Architecture/Spindrift]].
	- ```bash
	  kubectl --context folly cnpg status tronbyt -n tronbyt
	  kubectl --context folly get cluster.postgresql.cnpg.io -A
	  ```
- # Inspect
	- Health, topology, replication lag, and recent operator activity in one screen:
	- ```bash
	  kubectl --context <cluster> cnpg status <name> -n <namespace>
	  kubectl --context <cluster> cnpg status <name> -n <namespace> --verbose
	  ```
	- Logs for every instance, without picking a pod:
	- ```bash
	  kubectl --context <cluster> cnpg logs cluster <name> -n <namespace>
	  ```
- # Open a psql session
	- ```bash
	  kubectl --context <cluster> cnpg psql <name> -n <namespace>
	  ```
	- Add `--replica` to land on a standby instead — the right choice for a read-only look at a busy primary.
	- Non-interactive, for one statement:
	- ```bash
	  kubectl --context <cluster> cnpg psql <name> -n <namespace> -- -At -c 'select 1'
	  ```
	- Everything after `--` goes to `psql`, so its own flags work unchanged.
- # Restart and failover
	- Both are inspection-adjacent acts on a managed object, not edits to desired state:
	- ```bash
	  kubectl --context <cluster> cnpg restart <name> -n <namespace>
	  kubectl --context <cluster> cnpg promote <name> <name>-<n> -n <namespace>
	  ```
	- Changing instance count, storage, or Postgres version is a manifest change that ships through git — see [[Runbooks/Kubernetes GitOps Change]].
- # Backups are not universal
	- **Do not assume a database has a backup.** Each `Cluster` decides, and at least one chart deliberately declares none: the Spindrift control plane's database (`packages/charts/spindrift/templates/database.yaml`) states its loss story is reconcile-from-sources, with the desired-state rows, the attempt log, and the config version pins as the part no source holds. Its PVC therefore outlives the `Cluster` on purpose, so deleting the release does not discard them.
	- Check what a given cluster actually has before relying on one:
	- ```bash
	  kubectl --context <cluster> get cluster.postgresql.cnpg.io <name> -n <namespace> \
	    -o jsonpath='{.spec.backup}{"\n"}'
	  kubectl --context <cluster> get backup.postgresql.cnpg.io -n <namespace>
	  ```
	- Where a cluster does define one, take an on-demand backup with:
	- ```bash
	  kubectl --context <cluster> cnpg backup <name> -n <namespace>
	  ```
- # If psql cannot connect
	- Confirm the cluster is healthy and has a primary at all — `cnpg status` names it. A `Cluster` with no primary is a cluster mid-failover or mid-bootstrap, and the answer is to wait and read `cnpg logs cluster`, not to exec into an instance.
	- Confirm the plugin is present. It ships with the `kubectl` tooling in the dev shell:
	- ```bash
	  kubectl cnpg version
	  ```
	- Credentials live in a Secret the operator generates and rotates; read them from the `Cluster`'s app secret rather than from a chart's values. `cnpg psql` needs none of this, which is the main reason to prefer it.
