# clusters/folly/inventory/machines.yaml, NetBox's export, as an attrset of machines. Nix reads no
# YAML, and an import from a derivation would build on the evaluating host, so this reads the
# export's own shape: `machines:`, each machine's name two spaces in, and its scalar keys four
# spaces in. A key with a nested block, such as `bmc`, is left out. Values are strings, booleans
# or null.
{
  lib,
  path ? ../../clusters/folly/inventory/machines.yaml,
}:
let
  scalar =
    raw:
    let
      trimmed = lib.trim raw;
      # A YAML comment needs a space before its #, so a SKU such as V0B22UP#ABA keeps its #.
      commented = builtins.match "(.*[^[:space:]])[[:space:]]+#.*" trimmed;
      v = if commented == null then trimmed else lib.head commented;
      quoted = builtins.match "\"(.*)\"|'(.*)'" v;
    in
    if quoted != null then
      lib.findFirst (s: s != null) "" quoted
    else if v == "null" || v == "~" then
      null
    else if v == "true" then
      true
    else if v == "false" then
      false
    else
      v;
  step =
    state: line:
    let
      machine = builtins.match "  ([A-Za-z0-9_.-]+):[[:space:]]*" line;
      key = builtins.match "    ([A-Za-z0-9_]+):[[:space:]]*(.*)" line;
    in
    if builtins.match "[^ #].*" line != null then
      state
      // {
        inMachines = false;
        current = null;
      }
    else if machine != null && state.inMachines then
      {
        inherit (state) inMachines;
        current = lib.head machine;
        machines = state.machines // {
          ${lib.head machine} = { };
        };
      }
    else if key != null && state.current != null && lib.elemAt key 1 != "" then
      state
      // {
        machines = state.machines // {
          ${state.current} = state.machines.${state.current} // {
            ${lib.head key} = scalar (lib.elemAt key 1);
          };
        };
      }
    else
      state;
  lines = lib.splitString "\n" (builtins.readFile path);
  parsed =
    lib.foldl'
      (
        state: line:
        if line == "machines:" then
          state
          // {
            inMachines = true;
            current = null;
          }
        else
          step state line
      )
      {
        inMachines = false;
        current = null;
        machines = { };
      }
      lines;
in
parsed.machines
