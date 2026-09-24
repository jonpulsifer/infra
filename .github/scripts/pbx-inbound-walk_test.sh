#!/usr/bin/env bash
# Tests pbx-inbound-walk.awk against `dialplan show` text written the way
# Asterisk 22 prints it. AWK picks the interpreter, so CI can run it under
# mawk as well as gawk.
# shellcheck disable=SC2016 # every ${...} in a fixture is Asterisk's

set -euo pipefail

walker="$(cd "$(dirname "$0")" && pwd)/pbx-inbound-walk.awk"
awk_bin=${AWK:-awk}

# A context header, then one "exten|priority|app" or "include:<context>" row
# per argument. The leading newline survives command substitution; a trailing
# one would not.
context() {
  local name=$1 row exten prio app last=""
  shift
  printf "\n[ Context '%s' created by 'pbx_config' ]\n" "$name"
  for row in "$@"; do
    if [[ $row == include:* ]]; then
      printf "  %-17s %-45s [pbx_config]\n" "Include =>" "'${row#include:}'"
      continue
    fi
    IFS='|' read -r exten prio app <<<"$row"
    if [[ $exten != "$last" ]]; then
      printf "  %-17s %-45s [extensions.conf:1]\n" "'$exten' =>" "$prio. $app"
      last=$exten
    else
      printf "  %-17s %-45s [extensions.conf:1]\n" "" "$prio. $app"
    fi
  done
}

inbound() {
  context from-voipms \
    's|1|NoOp(inbound ${CALLERID(num)})' \
    "$@" \
    's|9|Hangup()' \
    '_X.|1|Goto(s,1)'
}

handset() {
  context from-handset \
    '_[*0-9]!|1|NoOp(${CHANNEL(endpoint)} -> ${EXTEN} via ${TRUNK})' \
    '_[*0-9]!|2|Dial(PJSIP/${EXTEN}@${TRUNK},60)' \
    '_[*0-9]!|3|Hangup()'
}

check() {
  local name=$1 want_status=$2 want_text=$3 dialplan=$4 roots=${5:-from-voipms} out status=0
  out=$("$awk_bin" -v roots="$roots" -f "$walker" <<<"$dialplan") || status=$?
  if [[ $status != "$want_status" || $out != *"$want_text"* ]]; then
    printf 'FAIL: %s\nwant exit %s and output containing: %s\ngot exit %s:\n%s\n' \
      "$name" "$want_status" "$want_text" "$status" "$out" >&2
    exit 1
  fi
}

check 'the live inbound path rings only the handset' 0 'inbound reaches 1 context(s)' \
  "$(inbound 's|2|Dial(PJSIP/${HANDSET},25)')$(handset)"

check 'a trunk dial from inbound is refused' 1 'dials PJSIP/${CALLERID(num)}@vms-1994' \
  "$(inbound 's|2|Dial(PJSIP/${CALLERID(num)}@vms-1994,30)')"

check 'a bare number to any endpoint is refused' 1 'dials PJSIP/911@vms-cathy' \
  "$(inbound 's|2|Dial(PJSIP/911@vms-cathy)')"

check 'a fixed agent number is allowed' 0 'none of them a trunk' \
  "$(inbound 's|2|Dial(PJSIP/+15555550100@elevenlabs,60)')"

check 'a caller-chosen agent number is refused' 1 'dials PJSIP/${CALLERID(num)}@elevenlabs' \
  "$(inbound 's|2|Dial(PJSIP/${CALLERID(num)}@elevenlabs,60)')"

check 'transfer options on the handset dial are refused' 1 'option t, T, k, K, x or X' \
  "$(inbound 's|2|Dial(PJSIP/${HANDSET},25,Tr)')"

check 'option letters inside a group are not options' 0 'none of them a trunk' \
  "$(inbound 's|2|Dial(PJSIP/${HANDSET},25,b(hdr^s^1(xT)))')$(context hdr 's|1|Return()')"

check 'options from a variable are refused' 1 'takes its options from a variable' \
  "$(inbound 's|2|Dial(PJSIP/${HANDSET},25,${OPTS})')"

check 'an include is followed' 1 'calls disa()' \
  "$(inbound 'include:dial-tone')$(context dial-tone 's|1|DISA(no-password,from-handset)')"

check 'a Goto is followed' 1 'calls chanspy()' \
  "$(inbound 's|2|Goto(listen,s,1)')$(context listen 's|1|ChanSpy(PJSIP/line1,q)')"

check 'both GotoIf branches are followed' 1 'calls system()' \
  "$(inbound 's|2|GotoIf($[${X} ? 1 :: 0]?ok,s,1:shell,s,1)')$(context ok 's|1|Return()')$(context shell 's|1|System(id)')"

check 'a Local/ leg is followed' 1 'calls shell()' \
  "$(inbound 's|2|Dial(PJSIP/${HANDSET}&Local/s@push/n,25)')$(context push 's|1|Set(X=${SHELL(id)})')"

check 'a pre-dial handler is followed' 1 'dials PJSIP/${EXTEN}@vms-1994' \
  "$(inbound 's|2|Dial(PJSIP/${HANDSET},25,b(hdr^s^1))')$(context hdr 's|1|Dial(PJSIP/${EXTEN}@vms-1994)')"

check 'a Gosub with arguments is followed' 1 'calls originate()' \
  "$(inbound 's|2|Gosub(sub,s,1(a,b))')$(context sub 's|1|Originate(PJSIP/line1,exten,x,s,1)')"

check 'a hangup handler is followed' 1 'calls extenspy()' \
  "$(inbound 's|2|Set(CHANNEL(hangup_handler_push)=hh,s,1)')$(context hh 's|1|ExtenSpy(1@x)')"

check 'a Dial nested in ExecIf is read' 1 'dials PJSIP/1@vms-1994' \
  "$(inbound 's|2|ExecIf($[1]?Dial(PJSIP/1@vms-1994))')"

check 'an application named by a variable is refused' 1 'runs an application named by a variable' \
  "$(inbound 's|2|ExecIf($[1]?${APP}(x))')"

check 'a context named by a variable is refused' 1 'jumps to a context named by a variable' \
  "$(inbound 's|2|Goto(${WHERE},s,1)')"

check 'an extension named by a variable is refused' 1 'jumps to an extension named by a variable' \
  "$(inbound 's|2|Goto(contacts,${CALLERID(num)},1)')$(context contacts 's|1|Return()')"

check 'a missing context is refused' 1 "reaches context 'nowhere', which does not exist" \
  "$(inbound 's|2|Goto(nowhere,s,1)')"

check 'rebinding HANDSET is refused' 1 'rebinds HANDSET' \
  "$(inbound 's|2|Set(__HANDSET=vms-1994)')"

check 'a handset-only context may spy' 0 'none of them a trunk' \
  "$(inbound 's|2|Dial(PJSIP/${HANDSET},25)')$(handset)$(context toybox 's|1|ChanSpy(PJSIP/line1,q)')"

check 'every root is walked' 1 'dials PJSIP/1@vms-1994' \
  "$(inbound)$(context from-elevenlabs '_X.|1|Dial(PJSIP/1@vms-1994)')" 'from-voipms from-elevenlabs'

check 'a missing inbound context is refused' 1 'the inbound context does not exist' \
  "$(handset)"

check 'a fast CURLOPT timeout passes' 0 'none of them a trunk' \
  "$(inbound)$(context push 's|1|Set(CURLOPT(conntimeout)=0.3)' 's|2|Set(CURLOPT(httptimeout)=2)')"

check 'a slow CURLOPT timeout fails anywhere in the dialplan' 1 "'800' must be a literal under 5" \
  "$(inbound)$(context push 's|1|Set(CURLOPT(httptimeout)=800)')"

check 'a CURLOPT timeout from a variable fails' 1 "'\${T}' must be a literal under 5" \
  "$(inbound)$(context push 's|1|Set(CURLOPT(conntimeout)=${T})')"

echo "pbx-inbound-walk: all tests passed ($awk_bin)"
