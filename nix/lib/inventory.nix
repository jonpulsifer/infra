# clusters/folly/inventory/machines.yaml, NetBox's export, as an attrset of machines. Nix reads no
# YAML, and an import from a derivation would build on the evaluating host, so this reads the
# export's own shape: `machines:`, each machine's name two spaces in, and its scalar keys four
# spaces in. A key with a nested block, such as `bmc`, is left out. Values are strings, booleans
# or null. Any line inside `machines:` outside that shape throws, so a change to the export's
# shape fails evaluation instead of dropping or merging machines.
{
  lib,
  path ? ../../clusters/folly/inventory/machines.yaml,
}:
let
  name = "[A-Za-z0-9_.-]+";
  # A key, bare or quoted; group 1, 2 or 3 holds it.
  keyRe = "(${name})|\"(${name})\"|'(${name})'";
  comment = "([[:space:]]+#.*)?";
  keyOf = groups: lib.findFirst (g: g != null) null (lib.take 3 groups);

  fail =
    n: line:
    throw "nix/lib/inventory.nix: ${toString path} line ${toString n} is outside the shape this reader takes: ${builtins.toJSON line}";

  # A value after `key:`, or null when the key opens a nested block.
  value =
    n: line: raw:
    let
      v = lib.trim raw;
      double = builtins.match "\"([^\"]*)\"${comment}" v;
      single = builtins.match "'([^']*)'${comment}" v;
      # A YAML comment needs whitespace before its #, so a SKU such as V0B22UP#ABA keeps its #.
      bare = lib.trim (lib.head (builtins.split "[[:space:]]#" v));
      # Flow collections, block scalars, anchors, tags and the like are not this export's shape.
      special = builtins.match "[][\"'{}|>&*!%@`].*" bare != null;
    in
    if v == "" || lib.hasPrefix "#" v then
      { nested = true; }
    else if double != null then
      { scalar = lib.head double; }
    else if single != null then
      { scalar = lib.head single; }
    else if special then
      fail n line
    else
      {
        scalar =
          if bare == "null" || bare == "~" then
            null
          else if bare == "true" then
            true
          else if bare == "false" then
            false
          else
            bare;
      };

  step =
    state: entry:
    let
      n = entry.n;
      line = entry.line;
      topMachines = builtins.match "machines:${comment}" line;
      noMachines = builtins.match "machines:[[:space:]]*\\{}${comment}" line;
      machine = builtins.match "  (${keyRe}):${comment}" line;
      key = builtins.match "    (${keyRe}):(.*)" line;
      deeper = builtins.match "      .*" line;
    in
    if builtins.match "[[:space:]]*(#.*)?" line != null then
      state
    else if topMachines != null then
      if state.seen then
        fail n line
      else
        state
        // {
          inMachines = true;
          seen = true;
        }
    # The export of an empty fleet.
    else if noMachines != null then
      if state.seen then
        fail n line
      else
        state
        // {
          inMachines = false;
          seen = true;
        }
    else if builtins.match "[^[:space:]].*" line != null then
      state
      // {
        inMachines = false;
        current = null;
        nested = false;
      }
    else if !state.inMachines then
      state
    else if machine != null then
      let
        m = keyOf (lib.tail machine);
      in
      if state.machines ? ${m} then
        fail n line
      else
        state
        // {
          current = m;
          nested = false;
          machines = state.machines // {
            ${m} = { };
          };
        }
    else if key != null && state.current != null then
      let
        k = keyOf (lib.tail key);
        v = value n line (lib.last key);
      in
      if state.machines.${state.current} ? ${k} then
        fail n line
      else if v ? nested then
        state // { nested = true; }
      else
        state
        // {
          nested = false;
          machines = state.machines // {
            ${state.current} = state.machines.${state.current} // {
              ${k} = v.scalar;
            };
          };
        }
    else if deeper != null && state.nested then
      state
    else
      fail n line;

  lines = lib.imap1 (n: line: {
    inherit n;
    line = lib.removeSuffix "\r" line;
  }) (lib.splitString "\n" (builtins.readFile path));
  parsed = lib.foldl' step {
    inMachines = false;
    seen = false;
    current = null;
    nested = false;
    machines = { };
  } lines;
in
if parsed.seen then
  parsed.machines
else
  throw "nix/lib/inventory.nix: ${toString path} has no top-level machines: key"
