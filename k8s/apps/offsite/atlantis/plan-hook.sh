#!/bin/bash
# https://www.runatlantis.io/docs/pre-workflow-hooks#custom-run-command

sed "s/USERNAME/$USERNAME/g" /home/atlantis/policies/only-me.json | \
    conftest test --namespace hooks -p /home/atlantis/policies/only-me.rego -