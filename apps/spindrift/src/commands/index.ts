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
 * v1 has exactly one act: creating an App (§2). Building, deploying,
 * rollback, placement, and desired-state changes are §21's other named
 * commands and arrive with the milestones that implement them.
 */
export { createApp } from './create-app.ts';
