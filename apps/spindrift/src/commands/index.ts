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
export { resolveComponentPlacement } from './apps/resolve-placement.ts';
export { uploadArchive } from './apps/upload-archive.ts';
export { dispatchBuild } from './builds/dispatch.ts';
export { createComponent } from './components/create.ts';
export { createApp } from './create-app.ts';
export { createDeploy } from './deploys/create.ts';
export { rollbackDeploy } from './deploys/rollback.ts';
export { connectRepository } from './repositories/connect.ts';
export { connectTarget } from './targets/connect.ts';
export { disconnectTarget } from './targets/disconnect.ts';
