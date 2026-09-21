#!/usr/bin/env bash
# Render /etc/asterisk from the mounted templates, substituting only the
# variables this deployment injects.
#
# The variable list is not optional and not a convenience. Asterisk's dialplan
# is written in ${EXTEN}, ${CALLERID(num)} and ${CHANNEL}, which is exactly
# envsubst's syntax — a bare `envsubst` blanks every one of them and leaves a
# dialplan that dials nothing. Passing an explicit SHELL-FORMAT restricts it to
# the names below, so Asterisk's own variables survive untouched.
#
# `compgen -e` rather than parsing `printenv`, because a secret with a newline
# in it would split a line-oriented parse into nonsense.
set -euo pipefail

vars=""
for name in $(compgen -e); do
  case "$name" in
    PBX_*) vars+=" \${$name}" ;;
  esac
done

shopt -s nullglob
for template in /templates/base/*.conf /templates/site/*.conf; do
  envsubst "$vars" <"$template" >"/etc/asterisk/$(basename "$template")"
done

echo "rendered: $(ls /etc/asterisk | tr '\n' ' ')"
echo "substituted:$vars"
