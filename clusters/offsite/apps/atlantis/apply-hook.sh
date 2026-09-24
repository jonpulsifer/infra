#!/bin/bash
# https://www.runatlantis.io/docs/pre-workflow-hooks#custom-run-command

sed "s/USERNAME/$USER_NAME/g" /home/atlantis/policies/only-me.json | \
    conftest test --no-color --namespace appliers -p /home/atlantis/policies/appliers.rego -
