---
title: Style guide
description: The rules for writing and reviewing wiki pages, runbooks and code comments in this repository.
---

Writers and reviewers apply these rules to wiki pages and code comments. The readers are the owner, then agents, then the public.

Open every page with what the thing is and who uses it. Define each lab-specific term on first use. The wiki is public, so never put a decrypted secret on a page.

## Sections

| Directory | What goes there |
| --- | --- |
| `docs/apps/` | One page per running first-party service, and one per parked app |
| `docs/platform/` | Shared systems that apps and hosts depend on |
| `docs/hosts/` | One sheet per machine |
| `docs/runbooks/` | Step-by-step procedures |
| `docs/reference/` | Lookup pages |

File names are lowercase kebab-case. List every page in `docs/nav.yaml`, or the build fails.

| Page | File name | Title |
| --- | --- | --- |
| App | Its main directory under `apps/`, or its product name | The name people see (`mate.md` is Rowbutt) |
| Host | The host name | The host name |
| Runbook | The title in kebab-case | An imperative verb first, as in Deploy a NixOS host |

The product in `apps/spindrift/` is kthx. Write `spindrift` only as a path.

Document what runs today. A parked app gets a short page with `status: parked`. `STATUSES` in `apps/wiki/build.ts` lists the valid `status` values.

## Voice

Keep sentences to about 25 words. Pages have word budgets: app page 400, platform page 450, runbook 800, host sheet 120. Frontmatter and code blocks do not count. Split a page that exceeds its budget.

Reviewers reject the patterns below. Only this page may quote them.

| Rule | Reject |
| --- | --- |
| Say what it is | "This is not X. It's Y.", "Not a X. Not a Y. A Z.", "rather than" |
| Start with the claim | "Here's the thing", "Let me be clear", "What most people get wrong", "Think about it:", "The key point is", "As you can see", "In other words" |
| Use colons for lists, labels and quotes | "The detail that makes it work: a separate agent grades it." |
| Prefer is and has | "serves as a centralized hub", "plays a vital role", "stands as a testament" |
| Cut trailing -ing clauses | "…, highlighting the need for review" |
| Name the source | "Experts agree", "studies show" |
| Repeat the right word | node, machine and box for one thing |
| Write complete sentences | "Small. And fast. And local.", a question you answer yourself |
| End on the last concrete point | "In conclusion", "Ultimately", a closing metaphor |
| Plain formatting | Emoji in headings, bold in a sentence, bold as a heading |
| Present tense, no process diary | "formerly", "used to be", "previously", "no longer", "migrated from", dates, "measured on riptide", incidents, PR or ticket numbers, `§N`, `.agent/` paths |
| At most one sentence of why, after the fact | A paragraph of rationale |
| Point at the tree and the source-of-truth key | A list of the `apps/` directories, or an IP, CIDR or ASN copied from `clusters/<site>/config/cluster-topology.json` |
| Literal words, such as boundary and applies | "door", "seam", "hold latch", "desk", "outer ring", "stamp", "lands", "wedge" |
| No intensifiers or stock frames | "whole", "exactly", "actually", "simply", "deliberately", "on purpose", "honest", "load-bearing", "fully capable", "self-healing", "entirely", "is what makes", "never … only …" |
| "Owner" is the human, and each controller has its own name | "The operator applies it" for Flux |

## Page templates

Copy the skeleton, replace each `<placeholder>`, and leave out empty sections. The runbook skeleton is under [Runbooks](#runbooks).

### App page

````markdown
---
title: <Name people see>
description: <What it is and who uses it, in one sentence.>
status: live
---

<What it is and who uses it.>

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |

## Limits

## How it works

<150 words or fewer.>

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |

## Reference

- Source: `apps/<dir>/`
- Manifests: `clusters/<site>/apps/<dir>/`
- Image: `ghcr.io/jonpulsifer/<image>`
````

### Platform page

````markdown
---
title: <Name>
description: <What it is, in one sentence.>
---

<What it is and what depends on it.>

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |

## Rules

- <Constraint.> <What breaks when you ignore it.>

## Where it lives

- `<path>`: <what is there>
- `<source-of-truth file>`: `<key>`

## Related
````

### Host sheet

````markdown
---
title: <hostname>
description: <The machine and its job, in one sentence.>
specs:
  vendor: <vendor>
  model: <model>
  serial: <serial>
  cpu: <cpu>
  ram: <ram>
  storage: <storage>
  os: <os>
---

<What the machine is and its job.>

## What it runs

## Reach

## Quirks

<Three or fewer.>
````

## Runbooks

Runbooks follow [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/) as guidance.

- Keep steps to 20 words or fewer and other sentences to 25 or fewer.
- Write one instruction in each sentence, in the imperative and the active voice. Keep "the" and "a".
- Put the condition first: "If the pod restarts, read its logs."
- Write "make sure" in place of "verify", "ensure" and "confirm".
- Do not use phrasal verbs such as "set up". In steps, do not use -ing verb forms or contractions.
- Technical verbs such as run, commit, deploy, apply, reconcile, restart and sign in are allowed.
- Put a notice before the step it applies to.
- After a step that prints output, add a result line.
- Put reasons in the purpose sentence or a notice, not in steps.

| Notice | Use it for |
| --- | --- |
| `[!WARNING]` | Data loss, credential exposure, or damage you cannot undo |
| `[!CAUTION]` | An outage, or a failure you can recover from |
| `[!NOTE]` | Information, never an instruction |

A runbook has every skeleton section, in order. It has the WARNING only if it changes live state by hand, which breaks the [GitOps rule](../platform/how-changes-ship.md).

````markdown
---
title: <Verb> <object>
description: <What the procedure does, in one sentence.>
---

<What the procedure does and when to use it.>

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because <reason>.

## Before you start

- <Access, tools and state the procedure needs.>

## <Procedure>

1. <Instruction.>

   ```bash
   <command>
   ```

   Result: <what the command prints>.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |

## Related
````

## Code comments

Comment only on a constraint the code cannot show: a protocol or vendor quirk, a unit, an ordering, a security boundary, or the reason for a value.

- Put the comment at the line it constrains, in two lines or fewer.
- Keep a module header to three lines that say what the module is.
- Follow the present-tense rule in [Voice](#voice).
- Do not use banners or Markdown.
- Never edit a comment that a tool reads: lint and compiler directives such as `biome-ignore`, `@ts-expect-error` and `shellcheck disable`, build tags, `# renovate:` annotations, shebangs and `BEGIN_TF_DOCS` markers.
