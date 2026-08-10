/**
 * The commands. One export per user act (§21), and nothing else.
 *
 * The rule this file exists to make checkable: **every value exported here is
 * a `Command`, and every one of them is registered in `registry.ts`.** Both
 * halves are enforced — at compile time by the exhaustiveness assertions in
 * `registry.ts`, and at run time by `test/commands/registry.test.ts` — because
 * the browser dispatch surface is generated from the registry, so a command
 * that is exported but unregistered is a command nobody can call.
 *
 * Input schemas, input types, and result types stay in each command's own
 * module. Keeping this file to values of one type is what lets the check above
 * be "every export", with no allowlist to fall out of date.
 *
 * Building, deploying, rollback, and desired-state changes are §21's other
 * named commands and arrive with the milestones that implement them.
 */

export { setAppAutoDeploy } from './apps/auto-deploy.ts';
export { setAppBuildRoute } from './apps/build-route.ts';
export { deleteApp } from './apps/delete.ts';
export { deployApp } from './apps/deploy.ts';
export { listApps } from './apps/list.ts';
export { resolveComponentPlacement } from './apps/resolve-placement.ts';
export { uploadArchive } from './apps/upload-archive.ts';
export { getAppWorkspace } from './apps/workspace.ts';
export { listArtifacts } from './artifacts/list.ts';
export { dispatchBuild } from './builds/dispatch.ts';
export { getBuildDetail } from './builds/get-detail.ts';
export { listBuilds } from './builds/list.ts';
export { createComponent } from './components/create.ts';
export { placeComponent } from './components/place.ts';
export { setComponentReach } from './components/reach.ts';
export { runComponent } from './components/run.ts';
export { setComponentSchedule } from './components/schedule.ts';
export { unplaceComponent } from './components/unplace.ts';
export { replaceConfig } from './config/replace.ts';
export { setConfig } from './config/set.ts';
export {
  completeCreationDraft,
  getCreationDraft,
  saveCreationDraft,
  startCreationDraft,
} from './creation-drafts/lifecycle.ts';
export { attachDatastore } from './datastores/attach.ts';
export { createDatastore } from './datastores/create.ts';
export { destroyDatastore } from './datastores/destroy.ts';
export { detachDatastore } from './datastores/detach.ts';
export { createDeploy } from './deploys/create.ts';
export { getDeployDetail } from './deploys/get-detail.ts';
export { listDeploys } from './deploys/list.ts';
export { listAllDeploys } from './deploys/list-all.ts';
export { rollbackDeploy } from './deploys/rollback.ts';
export { configureInstallation } from './installation/configure.ts';
export { discoverInstallationFacts } from './installation/discover.ts';
export { getInstallationManifest } from './installation/get.ts';
export {
  beginRepositoryAuthorization,
  pollRepositoryAuthorization,
} from './repositories/authorize.ts';
export { connectRepository } from './repositories/connect.ts';
export { inspectRepository } from './repositories/inspect.ts';
export { listRepositories } from './repositories/list.ts';
export { listSources } from './sources/list.ts';
export { forgetRegistryCredential } from './storage/forget-registry-credential.ts';
export { listSourceBuckets } from './storage/list-buckets.ts';
export { listArtifactRegistries } from './storage/list-registries.ts';
export { setRegistryCredential } from './storage/set-registry-credential.ts';
export { testBucketPermissions } from './storage/test-bucket.ts';
export { testRegistryReachability } from './storage/test-registry.ts';
export { useSourceBucket } from './storage/use-bucket.ts';
export { useArtifactRegistry } from './storage/use-registry.ts';
export { connectTarget } from './targets/connect.ts';
export { disconnectTarget } from './targets/disconnect.ts';
export { listTargets } from './targets/list.ts';
export { probeCluster } from './targets/probe.ts';
export { openPrerequisiteRemediation } from './targets/remediate.ts';
