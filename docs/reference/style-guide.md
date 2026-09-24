---
title: Style guide
description: The rules for writing and reviewing wiki pages, runbooks and code comments in this repository.
---

This guide is the rule book for wiki pages and code comments in this repository. Writers follow it, and reviewers check each change against it.

## Who reads the wiki

The readers are the owner first, then agents, then the public. Agents read it through the wiki's [Model Context Protocol server](../runbooks/connect-an-agent-to-the-wiki.md).

Readers forget details between visits, so every page follows one rule. Its first paragraph says what the thing is and who uses it. Define each term the first time a page uses it.

The wiki is public. Never put a decrypted secret on a page.

## Sections

| Section | Directory | What goes there |
| --- | --- | --- |
| Apps | `docs/apps/` | One page for each first-party service that runs |
| Platform | `docs/platform/` | The shared systems that apps and hosts depend on |
| Hosts | `docs/hosts/` | One sheet for each machine |
| Runbooks | `docs/runbooks/` | Step-by-step procedures |
| Reference | `docs/reference/` | Lookup pages, such as this guide |

File names are lowercase kebab-case. `docs/nav.yaml` lists every page, and the build fails on a page it does not list.

An app page's file name is its directory under `apps/`, and its title is the name people see, so `docs/apps/mate.md` is titled Rowbutt. The product in `apps/spindrift/` is kthx, and that directory name appears only as a path.

A host sheet's file name and title are the host name. A runbook title starts with an imperative verb, as in Deploy a NixOS host, and its file name is the title in kebab-case.

Document what runs today. A parked app gets a short page with `status: parked`. The build accepts the `status` values in `STATUSES` in `apps/wiki/build.ts`.

## Voice

Write short, plain sentences in the present tense, about 25 words at most on concept pages. Reviewers reject the patterns below, and this page alone may quote them.

| Rule | Write this | Not this |
| --- | --- | --- |
| Say what it is | Flux applies it on merge to `main`. | "This is not X. It's Y.", "Not a X. Not a Y. A Z.", "rather than" |
| Start with the claim | State it. | "Here's the thing", "Let me be clear", "What most people get wrong", "Think about it:" |
| Use colons for lists, labels and quotes | A separate agent grades it. | "The detail that makes it work: a separate agent grades it." |
| Prefer is and has | The page lists the alerts. | "serves as a centralized hub", "plays a vital role", "stands as a testament" |
| Cut trailing -ing clauses | The check fails. | "…, highlighting the need for review" |
| Cut asides about the text | Delete them. | "The key point is", "As you can see", "In other words" |
| Name the source | Link it. | "Experts agree", "studies show" |
| Repeat the right word | node, node | node, machine, box |
| Write complete sentences | It is small, fast and local. | "Small. And fast. And local.", a question you answer yourself |
| End on the last concrete point | The last fact or step. | "In conclusion", "Ultimately", a closing metaphor |
| Plain formatting | A heading over a real section. | Emoji in headings, bold in a sentence, bold as a heading |
| Present tense | Hosts rebuild from `main`. | "formerly", "used to be", "previously", "no longer", "migrated from" |
| No process diary | The current fact. | Dates, "measured on riptide", incidents, PR or ticket numbers, `§N`, `.agent/` paths |
| One sentence of why, after the fact | The fact. One reason. | A paragraph of rationale |
| Point at the tree | The services are in `apps/`. | A list of the directories in `apps/` |
| Name the source-of-truth key | The key in `clusters/<site>/config/cluster-topology.json`. | An IP, CIDR or ASN copied from it |
| Literal words | boundary, record, applies | "door", "seam", "hold latch", "desk", "outer ring", "stamp", "lands", "wedge" |
| No intensifiers or stock frames | Drop them. | "whole", "exactly", "actually", "simply", "deliberately", "on purpose", "honest", "load-bearing", "fully capable", "self-healing", "entirely", "is what makes", "never … only …" |
| "Operator" is the human | Flux applies it. | "The operator applies it," for a controller |

## Page templates

Copy the skeleton for the page type and replace each `<placeholder>`. Leave out a section that has nothing to say. The runbook skeleton is under [Runbooks](#runbooks).

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

- Keep procedural sentences to 20 words or fewer and descriptive sentences to 25 or fewer.
- Write one instruction in each sentence.
- Use the imperative and the active voice. Keep "the" and "a".
- Put the condition first: "If the pod restarts, read its logs."
- Write "make sure" in place of "verify", "ensure" and "confirm".
- Do not use phrasal verbs such as "set up" or "turn off". Do not use -ing verb forms or contractions in steps.
- Technical verbs are allowed: run, commit, push, merge, deploy, apply, reconcile, build, restart, delete, open, select, enter, sign in, copy, paste, wait.
- Put a notice before the step it applies to.
- After a step that prints output, add a result line.
- Keep reasons out of steps. Put them in the purpose sentence or a notice.

| Notice | Use it for |
| --- | --- |
| `[!WARNING]` | Data loss, credential exposure, or damage you cannot undo |
| `[!CAUTION]` | An outage, or a failure you can recover from |
| `[!NOTE]` | Information. A note never gives an instruction. |

A runbook has these sections in this order: a purpose sentence, Before you start, one or more procedures, If something goes wrong, and Related. A runbook that changes live state by hand has a WARNING after the purpose sentence. The WARNING names the exception to the [GitOps rule](../platform/how-changes-ship.md), which forbids changes to live infrastructure by hand.

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

Keep a comment only for a constraint the code cannot show. Such a constraint is a protocol or vendor quirk, a unit, an ordering, a security boundary, or the reason for a specific value.

- Put the comment at the line it constrains, in two lines or fewer.
- Keep a module header to three lines that say what the module is.
- Write in the present tense. Leave out history, dates, incidents, PR or ticket numbers, `§` references and `.agent/` paths.
- Do not use banners or Markdown.
- Never edit a comment that a tool reads. These include lint and compiler directives such as `biome-ignore`, `@ts-expect-error` and `shellcheck disable`, build tags, `# renovate:` annotations, shebangs and `BEGIN_TF_DOCS` markers.
