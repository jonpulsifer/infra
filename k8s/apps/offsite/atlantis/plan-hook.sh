#!/bin/bash
# https://www.runatlantis.io/docs/pre-workflow-hooks#custom-run-command


env > /atlantis-data/env.txt

sed "s/USERNAME/$USERNAME/g" /home/atlantis/policies/only-me.json | \
    conftest test --no-color --namespace hooks -p /home/atlantis/policies/only-me.rego -