# A rendered Template's workflow, as JSON, to a shell script that runs each action the way tink-agent
# does: a privileged container with the task's and the action's volumes and environment, and the
# action's command as the arguments to the image's entrypoint. The script runs in HookOS's
# hook-docker container, whose Docker daemon is the one the agent uses.
"#!/bin/sh",
"set -eu",
(.tasks[] as $t | $t.actions[] |
  "echo \"== \(.name)\"; start=$(date +%s)",
  (
    (["docker", "run", "--rm", "--privileged", "--name", .name]
      + ([($t.volumes // [])[], (.volumes // [])[]] | map(["-v", .]) | add // [])
      + ([($t.environment // {}) + (.environment // {}) | to_entries[] | ["-e", "\(.key)=\(.value)"]] | add // [])
      + [.image] + (.command // [])
      | @sh) + " || { echo \"== \(.name) failed after $(( $(date +%s) - start ))s\"; exit 1; }"
  ),
  "echo \"== \(.name) took $(( $(date +%s) - start ))s\""
)
