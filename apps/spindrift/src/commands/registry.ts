/**
 * The command registry: every command that exists, by name, with the schema
 * its input must satisfy.
 *
 * This object is the **single source the browser dispatch endpoint is
 * generated from**. §21 declines to declare an external API, and a React
 * client still needs a boundary to call across, so the boundary is one
 * generated dispatch point rather than hand-authored routes: adding an entry
 * here is the whole of adding a route, and a route that is not a command cannot
 * be written at all, because there is no place to write one. That is the whole
 * reason the registry exists rather than each page importing the command it
 * wants.
 *
 * It is also the **only** list of commands — no barrel beside it re-exporting
 * the same set. The invariant that has teeth is "no dispatchable name the
 * command layer does not back", and the `satisfies` clause below is what holds
 * it: an entry whose `handler` is not a {@link Command} does not type-check.
 * Its mirror — a handler that exists and is not registered — is unreachable
 * rather than wrong, and no list can catch it: a second list only ever noticed
 * the case where you remembered one of the two. `create-app.ts` is the standing
 * proof, a command that has never been dispatchable and never tripped anything.
 *
 * The HTTP endpoint is not here — Task 38 owns it, and it is deliberately a
 * thin wrapper: read a name and a JSON body, call {@link dispatch}, render the
 * result. §21's "no route may contain domain logic" is met by there being
 * nothing left for a route to decide.
 */
import type { z } from 'zod';
import { setAppAutoDeploy, setAppAutoDeployInput } from './apps/auto-deploy.ts';
import { setAppBuildRoute, setAppBuildRouteInput } from './apps/build-route.ts';
import { deleteApp, deleteAppInput } from './apps/delete.ts';
import { deployApp, deployAppRequestInput } from './apps/deploy.ts';
import { listApps, listAppsInput } from './apps/list.ts';
import {
  resolveComponentPlacement,
  resolveComponentPlacementInput,
} from './apps/resolve-placement.ts';
import { setAppLock, setAppLockInput } from './apps/set-lock.ts';
import { getAppSource, getAppSourceInput } from './apps/source.ts';
import { uploadArchive, uploadArchiveInput } from './apps/upload-archive.ts';
import { setAppVanity, setAppVanityInput } from './apps/vanity.ts';
import { getAppWorkspace, getAppWorkspaceInput } from './apps/workspace.ts';
import { setAppZone, setAppZoneInput } from './apps/zone.ts';
import { listArtifacts, listArtifactsInput } from './artifacts/list.ts';
import { adoptBuild, adoptBuildInput } from './builds/adopt.ts';
import { cancelBuild, cancelBuildInput } from './builds/cancel.ts';
import { dispatchBuild, dispatchBuildInput } from './builds/dispatch.ts';
import { getBuildDetail, getBuildDetailInput } from './builds/get-detail.ts';
import { listBuilds, listBuildsInput } from './builds/list.ts';
import { listBuildRoutes, listBuildRoutesInput } from './builds/list-routes.ts';
import {
  setComponentCommand,
  setComponentCommandInput,
} from './components/command.ts';
import { createComponent, createComponentInput } from './components/create.ts';
import { deleteComponent, deleteComponentInput } from './components/delete.ts';
import { placeComponent, placeComponentInput } from './components/place.ts';
import {
  setComponentReach,
  setComponentReachInput,
} from './components/reach.ts';
import {
  restartComponent,
  restartComponentInput,
} from './components/restart.ts';
import { runComponent, runComponentInput } from './components/run.ts';
import {
  setComponentSchedule,
  setComponentScheduleInput,
} from './components/schedule.ts';
import {
  unplaceComponent,
  unplaceComponentInput,
} from './components/unplace.ts';
import {
  setBuildSecrets,
  setBuildSecretsInput,
} from './config/build-secrets.ts';
import { replaceConfig, replaceConfigInput } from './config/replace.ts';
import { setConfig, setConfigInput } from './config/set.ts';
import {
  completeCreationDraft,
  completeCreationDraftInput,
  getCreationDraft,
  getCreationDraftInput,
  saveCreationDraft,
  saveCreationDraftInput,
  startCreationDraft,
  startCreationDraftInput,
} from './creation-drafts/lifecycle.ts';
import { attachDatastore, attachDatastoreInput } from './datastores/attach.ts';
import { createDatastore, createDatastoreInput } from './datastores/create.ts';
import {
  destroyDatastore,
  destroyDatastoreInput,
} from './datastores/destroy.ts';
import { detachDatastore, detachDatastoreInput } from './datastores/detach.ts';
import { getDatastore, getDatastoreInput } from './datastores/get.ts';
import { listDatastores, listDatastoresInput } from './datastores/list.ts';
import { cancelDeploy, cancelDeployInput } from './deploys/cancel.ts';
import { createDeploy, createDeployInput } from './deploys/create.ts';
import { getDeployDetail, getDeployDetailInput } from './deploys/get-detail.ts';
import { listDeploys, listDeploysInput } from './deploys/list.ts';
import { listAllDeploys, listAllDeploysInput } from './deploys/list-all.ts';
import { rollbackDeploy, rollbackDeployInput } from './deploys/rollback.ts';
import { deleteFunction, deleteFunctionInput } from './functions/delete.ts';
import { getFunction, getFunctionInput } from './functions/get.ts';
import { listFunctions, listFunctionsInput } from './functions/list.ts';
import { probeFunction, probeFunctionInput } from './functions/probe.ts';
import { runFunction, runFunctionInput } from './functions/run.ts';
import { saveFunction, saveFunctionInput } from './functions/save.ts';
import {
  configureInstallation,
  configureInstallationInput,
} from './installation/configure.ts';
import {
  discoverInstallationFacts,
  discoverInstallationFactsInput,
} from './installation/discover.ts';
import {
  getInstallationManifest,
  getInstallationManifestInput,
} from './installation/get.ts';
import {
  connectRepository,
  connectRepositoryInput,
} from './repositories/connect.ts';
import {
  inspectRepository,
  inspectRepositoryInput,
} from './repositories/inspect.ts';
import {
  listRepositories,
  listRepositoriesInput,
} from './repositories/list.ts';
import { listSources, listSourcesInput } from './sources/list.ts';
import {
  forgetRegistryCredential,
  forgetRegistryCredentialInput,
} from './storage/forget-registry-credential.ts';
import {
  listSourceBuckets,
  listSourceBucketsInput,
} from './storage/list-buckets.ts';
import {
  listArtifactRegistries,
  listArtifactRegistriesInput,
} from './storage/list-registries.ts';
import {
  setRegistryCredential,
  setRegistryCredentialInput,
} from './storage/set-registry-credential.ts';
import {
  testBucketPermissions,
  testBucketPermissionsInput,
} from './storage/test-bucket.ts';
import {
  testRegistryReachability,
  testRegistryReachabilityInput,
} from './storage/test-registry.ts';
import { useSourceBucket, useSourceBucketInput } from './storage/use-bucket.ts';
import {
  useArtifactRegistry,
  useArtifactRegistryInput,
} from './storage/use-registry.ts';
import { connectTarget, connectTargetInput } from './targets/connect.ts';
import {
  disconnectTarget,
  disconnectTargetInput,
} from './targets/disconnect.ts';
import { listTargets, listTargetsInput } from './targets/list.ts';
import { probeCluster, probeClusterInput } from './targets/probe.ts';
import {
  openPrerequisiteRemediation,
  openPrerequisiteRemediationInput,
} from './targets/remediate.ts';
import {
  type Command,
  type CommandContext,
  type CommandIssue,
  type CommandResult,
  failed,
} from './types.ts';

/** What the dispatch surface needs to know about one command. */
export interface CommandDescriptor<Input, Output> {
  /** Validates untrusted input before the handler ever sees it. */
  readonly input: z.ZodType<Input>;
  readonly handler: Command<Input, Output>;
}

/** A descriptor of unknown input and output — what the registry holds. */
export type AnyCommandDescriptor = CommandDescriptor<any, any>;

/** Every command, by the name it is dispatched under. */
export const commandRegistry = {
  deleteApp: { input: deleteAppInput, handler: deleteApp },
  deployApp: { input: deployAppRequestInput, handler: deployApp },
  setAppAutoDeploy: {
    input: setAppAutoDeployInput,
    handler: setAppAutoDeploy,
  },
  setAppLock: { input: setAppLockInput, handler: setAppLock },
  setAppBuildRoute: { input: setAppBuildRouteInput, handler: setAppBuildRoute },
  setAppZone: { input: setAppZoneInput, handler: setAppZone },
  setAppVanity: { input: setAppVanityInput, handler: setAppVanity },
  getAppWorkspace: { input: getAppWorkspaceInput, handler: getAppWorkspace },
  getAppSource: { input: getAppSourceInput, handler: getAppSource },
  getDeployDetail: { input: getDeployDetailInput, handler: getDeployDetail },
  getBuildDetail: { input: getBuildDetailInput, handler: getBuildDetail },
  listBuilds: { input: listBuildsInput, handler: listBuilds },
  listBuildRoutes: {
    input: listBuildRoutesInput,
    handler: listBuildRoutes,
  },
  listAllDeploys: { input: listAllDeploysInput, handler: listAllDeploys },
  listApps: { input: listAppsInput, handler: listApps },
  listDeploys: { input: listDeploysInput, handler: listDeploys },
  listTargets: { input: listTargetsInput, handler: listTargets },
  listRepositories: {
    input: listRepositoriesInput,
    handler: listRepositories,
  },
  startCreationDraft: {
    input: startCreationDraftInput,
    handler: startCreationDraft,
  },
  getCreationDraft: {
    input: getCreationDraftInput,
    handler: getCreationDraft,
  },
  saveCreationDraft: {
    input: saveCreationDraftInput,
    handler: saveCreationDraft,
  },
  completeCreationDraft: {
    input: completeCreationDraftInput,
    handler: completeCreationDraft,
  },
  createComponent: { input: createComponentInput, handler: createComponent },
  placeComponent: { input: placeComponentInput, handler: placeComponent },
  setComponentReach: {
    input: setComponentReachInput,
    handler: setComponentReach,
  },
  runComponent: { input: runComponentInput, handler: runComponent },
  restartComponent: {
    input: restartComponentInput,
    handler: restartComponent,
  },
  setComponentSchedule: {
    input: setComponentScheduleInput,
    handler: setComponentSchedule,
  },
  setComponentCommand: {
    input: setComponentCommandInput,
    handler: setComponentCommand,
  },
  unplaceComponent: {
    input: unplaceComponentInput,
    handler: unplaceComponent,
  },
  deleteComponent: {
    input: deleteComponentInput,
    handler: deleteComponent,
  },
  createDatastore: { input: createDatastoreInput, handler: createDatastore },
  attachDatastore: { input: attachDatastoreInput, handler: attachDatastore },
  detachDatastore: { input: detachDatastoreInput, handler: detachDatastore },
  destroyDatastore: {
    input: destroyDatastoreInput,
    handler: destroyDatastore,
  },
  listDatastores: { input: listDatastoresInput, handler: listDatastores },
  getDatastore: { input: getDatastoreInput, handler: getDatastore },
  listFunctions: { input: listFunctionsInput, handler: listFunctions },
  getFunction: { input: getFunctionInput, handler: getFunction },
  saveFunction: { input: saveFunctionInput, handler: saveFunction },
  runFunction: { input: runFunctionInput, handler: runFunction },
  deleteFunction: { input: deleteFunctionInput, handler: deleteFunction },
  probeFunction: { input: probeFunctionInput, handler: probeFunction },
  setConfig: { input: setConfigInput, handler: setConfig },
  setBuildSecrets: { input: setBuildSecretsInput, handler: setBuildSecrets },
  configureInstallation: {
    input: configureInstallationInput,
    handler: configureInstallation,
  },
  getInstallationManifest: {
    input: getInstallationManifestInput,
    handler: getInstallationManifest,
  },
  discoverInstallationFacts: {
    input: discoverInstallationFactsInput,
    handler: discoverInstallationFacts,
  },
  replaceConfig: { input: replaceConfigInput, handler: replaceConfig },
  uploadArchive: { input: uploadArchiveInput, handler: uploadArchive },
  adoptBuild: { input: adoptBuildInput, handler: adoptBuild },
  cancelBuild: { input: cancelBuildInput, handler: cancelBuild },
  dispatchBuild: { input: dispatchBuildInput, handler: dispatchBuild },
  createDeploy: { input: createDeployInput, handler: createDeploy },
  rollbackDeploy: { input: rollbackDeployInput, handler: rollbackDeploy },
  cancelDeploy: { input: cancelDeployInput, handler: cancelDeploy },
  connectRepository: {
    input: connectRepositoryInput,
    handler: connectRepository,
  },
  inspectRepository: {
    input: inspectRepositoryInput,
    handler: inspectRepository,
  },
  probeCluster: { input: probeClusterInput, handler: probeCluster },
  openPrerequisiteRemediation: {
    input: openPrerequisiteRemediationInput,
    handler: openPrerequisiteRemediation,
  },
  connectTarget: { input: connectTargetInput, handler: connectTarget },
  disconnectTarget: {
    input: disconnectTargetInput,
    handler: disconnectTarget,
  },
  resolveComponentPlacement: {
    input: resolveComponentPlacementInput,
    handler: resolveComponentPlacement,
  },
  listSourceBuckets: {
    input: listSourceBucketsInput,
    handler: listSourceBuckets,
  },
  testBucketPermissions: {
    input: testBucketPermissionsInput,
    handler: testBucketPermissions,
  },
  useSourceBucket: {
    input: useSourceBucketInput,
    handler: useSourceBucket,
  },
  listArtifactRegistries: {
    input: listArtifactRegistriesInput,
    handler: listArtifactRegistries,
  },
  testRegistryReachability: {
    input: testRegistryReachabilityInput,
    handler: testRegistryReachability,
  },
  useArtifactRegistry: {
    input: useArtifactRegistryInput,
    handler: useArtifactRegistry,
  },
  listSources: {
    input: listSourcesInput,
    handler: listSources,
  },
  listArtifacts: {
    input: listArtifactsInput,
    handler: listArtifacts,
  },
  setRegistryCredential: {
    input: setRegistryCredentialInput,
    handler: setRegistryCredential,
  },
  forgetRegistryCredential: {
    input: forgetRegistryCredentialInput,
    handler: forgetRegistryCredential,
  },
} as const satisfies Readonly<Record<string, AnyCommandDescriptor>>;

/** The closed set of dispatchable names. */
export type CommandName = keyof typeof commandRegistry;

/** The names, in a form route generation can iterate. */
export const commandNames: readonly CommandName[] = Object.keys(
  commandRegistry,
) as CommandName[];

/** Whether an untrusted string names a command. */
export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(commandRegistry, name);
}

/**
 * Run a named command against untrusted input.
 *
 * This is the entirety of what dispatch does, kept transport-free on purpose:
 * validate, then hand the parsed input to the handler. Anything a transport
 * adds — sessions, JSON decoding, status codes — sits above it and adds no
 * decision of its own.
 */
export async function dispatch(
  name: string,
  input: unknown,
  context: CommandContext,
): Promise<CommandResult<unknown>> {
  if (!isCommandName(name)) {
    return failed('UNKNOWN_COMMAND', `there is no command named ${name}`);
  }

  const descriptor: AnyCommandDescriptor = commandRegistry[name];
  const parsed = descriptor.input.safeParse(input);
  if (!parsed.success) {
    // Screens surface this sentence verbatim to an operator mid-flow, so the
    // command's camelCase name stays out of it — unlike the refusal above,
    // whose only reader is the programmer who typed the name. The issues
    // carry the fields that failed.
    return failed(
      'INVALID_INPUT',
      'the input given to this command is not valid',
      issuesOf(parsed.error),
    );
  }

  return descriptor.handler(parsed.data, context);
}

/** Zod's issues, flattened to the field-level detail a UI renders. */
function issuesOf(error: z.ZodError): readonly CommandIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
