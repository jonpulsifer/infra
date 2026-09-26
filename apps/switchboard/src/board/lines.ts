/** One line of the office phone and the voip.ms trunk it dials out on. */
export interface LinePlan {
  readonly line: string;
  readonly trunk: string | null;
  /** The trunk's voip.ms sub-account, from its registration's client_uri. */
  readonly account: string | null;
  /** SCREEN=yes on the trunk: unknown callers are asked to press 5. */
  readonly screened: boolean;
}

interface Section {
  vars: Map<string, string>;
  account?: string;
}

// `;` starts a comment unless escaped, as in server_uri's `\;transport=tls`.
function stripComment(line: string): string {
  const match = /(^|[^\\]);/.exec(line);
  return (
    match ? line.slice(0, match.index + (match[1] ?? '').length) : line
  ).trim();
}

/**
 * The lines pjsip.conf declares, read from the template the PBX renders. A
 * section name repeats once per object type (registration, endpoint, auth),
 * so every repeat folds into one entry. A line is an endpoint with
 * `set_var = TRUNK=<trunk>`; the trunk's own sections give its account and
 * whether it screens.
 */
export function parseLinePlan(text: string): LinePlan[] {
  const sections = new Map<string, Section>();
  let current: Section | undefined;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    if (!line) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      const name = header[1] as string;
      current = sections.get(name) ?? { vars: new Map() };
      sections.set(name, current);
      continue;
    }
    if (!current) continue;
    const setVar = /^set_var\s*=>?\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (setVar) {
      current.vars.set(setVar[1] as string, (setVar[2] as string).trim());
      continue;
    }
    const clientUri = /^client_uri\s*=>?\s*sips?:([^@;\s]+)@/.exec(line);
    if (clientUri) current.account = clientUri[1];
  }
  const plans: LinePlan[] = [];
  for (const [name, section] of sections) {
    const trunk = section.vars.get('TRUNK');
    if (trunk === undefined) continue;
    const trunkSection = sections.get(trunk);
    plans.push({
      line: name,
      trunk: trunk || null,
      account: trunkSection?.account ?? null,
      screened: trunkSection?.vars.get('SCREEN') === 'yes',
    });
  }
  return plans.sort((a, b) =>
    a.line.localeCompare(b.line, 'en', { numeric: true }),
  );
}
