# Reads `dialplan show` output and prints every priority, reachable from a
# context an inbound call starts in, that could hand a stranger a trunk, a
# shell or a listen-in. pbx-check.sh runs it against the booted Asterisk.
#
#   awk -v roots="from-voipms from-elevenlabs" -f pbx-inbound-walk.awk dialplan.txt
#
# A context is reachable through `include =>`, Goto, Gosub, their If and IfTime
# forms, a hangup handler, Dial's b/B/F/G/U options and a Local/ channel. Every
# priority in a reachable context counts, whether or not a call can get to it.
# A jump whose context or extension is a variable cannot be followed, and is a
# finding by itself, because a caller ID of `h`, `s` or `i` is a valid
# extension name.
#
# From a reachable priority, Dial and Page may name only PJSIP/${HANDSET} and
# PJSIP/<fixed number>@elevenlabs, plus Local/ legs, which are followed. No
# Dial or Queue option may grant a transfer, park or recording.
#
# In every context, CURLOPT's conntimeout and httptimeout must be literal
# seconds under 5. The unit is seconds, and a large value holds the call while
# the far end is down.
#
# The script is POSIX awk, and its test runs it under mawk as well as gawk.

BEGIN {
  nforbidden = split("chanspy extenspy disa system trysystem shell originate agi eagi deadagi", FORBIDDEN, " ")
}

/^\[ Context '/ {
  ctx = $0
  sub(/^\[ Context '/, "", ctx)
  sub(/' created by .*/, "", ctx)
  EXISTS[ctx] = 1
  exten = ""
  next
}

ctx == "" { next }

/^[[:space:]]*Include =>/ {
  target = $0
  sub(/^[^']*'/, "", target)
  sub(/'.*/, "", target)
  sub(/[,|].*/, "", target)
  NINC[ctx]++
  INC[ctx, NINC[ctx]] = target
  next
}

/^[[:space:]]*Alt\. Switch =>/ {
  add(ctx, "switch", $0)
  next
}

{
  if (match($0, /^  '[^']*'/)) exten = substr($0, RSTART + 3, RLENGTH - 4)
  if (!match($0, /(^|[[:space:]])[0-9]+\. /)) next
  prio = substr($0, RSTART, RLENGTH)
  gsub(/[^0-9]/, "", prio)
  body = substr($0, RSTART + RLENGTH)
  where = ""
  if (match(body, /[[:space:]]+\[[^][]*\][[:space:]]*$/)) {
    where = substr(body, RSTART, RLENGTH)
    body = substr(body, 1, RSTART - 1)
    gsub(/^[[:space:]]*\[|\][[:space:]]*$/, "", where)
  }
  loc = "'" exten "' priority " prio (where == "" ? "" : " (" where ")")
  add(ctx, loc, body)
  curlopt(ctx, loc, body)
}

END {
  nroots = split(roots, ROOT, " ")
  for (i = 1; i <= nroots; i++) {
    if (ROOT[i] in EXISTS) enqueue(ROOT[i])
    else if (ROOT[i] == "from-voipms") report("from-voipms", "-", "the inbound context does not exist", "")
  }
  while (head < tail) walk(QUEUE[head++])

  reached = ""
  for (i = 0; i < tail; i++) reached = reached (i ? " " : "") QUEUE[i]
  if (findings) {
    printf "%d finding(s); inbound reaches: %s\n", findings, reached
    exit 1
  }
  printf "inbound reaches %d context(s), none of them a trunk: %s\n", tail, reached
}

function add(c, loc, text) {
  N[c]++
  LOC[c, N[c]] = loc
  BODY[c, N[c]] = text
}

function enqueue(c) {
  if (c in SEEN) return
  SEEN[c] = 1
  QUEUE[tail++] = c
}

function report(c, loc, why, text) {
  findings++
  printf "  [%s] %s: %s\n", c, loc, why
  if (text != "") printf "      %s\n", trim(text)
}

function trim(s) {
  sub(/^[[:space:]]+/, "", s)
  sub(/[[:space:]]+$/, "", s)
  return s
}

function walk(c,   k) {
  if (c == "from-voipms" && N[c] == 0)
    report(c, "-", "no priorities parsed; has the `dialplan show` format changed?", "")
  for (k = 1; k <= NINC[c]; k++) reach(c, "include", "", INC[c, k])
  for (k = 1; k <= N[c]; k++) inspect(c, LOC[c, k], BODY[c, k])
}

function reach(c, loc, text, target) {
  target = trim(target)
  if (index(target, "$")) {
    report(c, loc, "jumps to a context named by a variable", text)
    return
  }
  if (!(target in EXISTS)) {
    report(c, loc, "reaches context '" target "', which does not exist", text)
    return
  }
  enqueue(target)
}

function inspect(c, loc, text,   low, i, rest, name, start, args) {
  if (loc == "switch") {
    report(c, loc, "an Alt. Switch finds extensions this walk cannot see", text)
    return
  }
  low = tolower(text)
  for (i = 1; i <= nforbidden; i++)
    if (match(low, "(^|[^a-z0-9_])" FORBIDDEN[i] "\\("))
      report(c, loc, "calls " FORBIDDEN[i] "()", text)

  # Every call in the priority, nested ones included, so ExecIf(...?Dial(...))
  # is read the same as a bare Dial.
  rest = text
  while (match(rest, /[A-Za-z_][A-Za-z0-9_]*\(/)) {
    name = tolower(substr(rest, RSTART, RLENGTH - 1))
    start = RSTART + RLENGTH
    args = balanced(rest, start)
    if (name == "goto" || name == "gosub") label(c, loc, text, args)
    else if (name == "gotoif" || name == "gosubif" || name == "gotoiftime") branches(c, loc, text, args, "label")
    else if (name == "execif" || name == "execiftime") branches(c, loc, text, args, "app")
    else if (name == "exec" || name == "tryexec") application(c, loc, text, args)
    else if (name == "dial") dial(c, loc, text, args, 1)
    else if (name == "page") dial(c, loc, text, args, 0)
    else if (name == "queue") queue(c, loc, text, args)
    else if (name == "set" || name == "mset") assignment(c, loc, text, args)
    rest = substr(rest, start)
  }
}

# The text between the parenthesis before `start` and its match.
function balanced(s, start,   i, ch, depth) {
  depth = 1
  for (i = start; i <= length(s); i++) {
    ch = substr(s, i, 1)
    if (ch == "(") depth++
    else if (ch == ")" && --depth == 0) return substr(s, start, i - start)
  }
  return substr(s, start)
}

# Splits on `sep` outside any (), {} or [], which keeps ${...} and $[...] intact.
function tsplit(s, parts, sep,   i, ch, depth, n, cur) {
  n = 0
  cur = ""
  depth = 0
  for (i = 1; i <= length(s); i++) {
    ch = substr(s, i, 1)
    if (ch == "(" || ch == "{" || ch == "[") depth++
    else if ((ch == ")" || ch == "}" || ch == "]") && depth > 0) depth--
    if (ch == sep && depth == 0) {
      parts[++n] = cur
      cur = ""
    } else cur = cur ch
  }
  parts[++n] = cur
  return n
}

function tindex(s, sep,   i, ch, depth) {
  depth = 0
  for (i = 1; i <= length(s); i++) {
    ch = substr(s, i, 1)
    if (ch == "(" || ch == "{" || ch == "[") depth++
    else if ((ch == ")" || ch == "}" || ch == "]") && depth > 0) depth--
    else if (ch == sep && depth == 0) return i
  }
  return 0
}

# [[context,]extension,]priority[(args)]
function label(c, loc, text, lbl,   n, parts, target, ext) {
  lbl = trim(lbl)
  if (lbl == "") return
  n = tsplit(lbl, parts, ",")
  target = c
  ext = ""
  if (n >= 3) {
    target = parts[1]
    ext = parts[2]
  } else if (n == 2) ext = parts[1]
  if (index(ext, "$")) report(c, loc, "jumps to an extension named by a variable", text)
  reach(c, loc, text, target)
}

# condition?iftrue[:iffalse], where each side is a label or an application.
function branches(c, loc, text, args, kind,   q, rest, colon, side, n, i) {
  q = tindex(args, "?")
  if (!q) return
  rest = substr(args, q + 1)
  colon = tindex(rest, ":")
  n = 1
  side[1] = rest
  if (colon) {
    side[1] = substr(rest, 1, colon - 1)
    side[2] = substr(rest, colon + 1)
    n = 2
  }
  for (i = 1; i <= n; i++) {
    if (kind == "label") label(c, loc, text, side[i])
    else application(c, loc, text, side[i])
  }
}

function application(c, loc, text, app) {
  if (substr(trim(app), 1, 1) == "$")
    report(c, loc, "runs an application named by a variable", text)
}

function dial(c, loc, text, args, isdial,   n, parts, m, targets, i) {
  n = tsplit(args, parts, ",")
  m = tsplit(parts[1], targets, "&")
  for (i = 1; i <= m; i++) destination(c, loc, text, trim(targets[i]))
  if (isdial && n >= 3) options(c, loc, text, parts[3])
}

function destination(c, loc, text, t,   tech, rest, slash, at, ext, target) {
  if (t == "") return
  tech = tolower(substr(t, 1, index(t, "/")))
  rest = substr(t, length(tech) + 1)
  if (tech == "local/") {
    slash = index(rest, "/")
    if (slash) rest = substr(rest, 1, slash - 1)
    at = index(rest, "@")
    ext = at ? substr(rest, 1, at - 1) : rest
    target = at ? substr(rest, at + 1) : "default"
    if (index(ext, "$")) report(c, loc, "dials a Local/ extension named by a variable", text)
    reach(c, loc, text, target)
    return
  }
  if (tech == "pjsip/" && rest == "${HANDSET}") return
  if (tech == "pjsip/" && rest ~ /^[^$@\/&]+@elevenlabs$/) return
  report(c, loc, "dials " t "; an inbound path may dial only PJSIP/${HANDSET} or PJSIP/<fixed number>@elevenlabs", text)
}

# Dial and Queue options: letters, some taking a (group). The groups of b, B,
# F, G and U name dialplan that runs on one of the call's channels.
function options(c, loc, text, opts,   i, ch, letters, depth, j, group) {
  letters = ""
  for (i = 1; i <= length(opts); i++) {
    ch = substr(opts, i, 1)
    if (substr(opts, i + 1, 1) == "(") {
      depth = 0
      for (j = i + 1; j <= length(opts); j++) {
        if (substr(opts, j, 1) == "(") depth++
        else if (substr(opts, j, 1) == ")" && --depth == 0) break
      }
      group = substr(opts, i + 2, j - i - 2)
      if (ch == "U") handler(c, loc, text, group, 1)
      else if (index("bBFG", ch)) handler(c, loc, text, group, 0)
      letters = letters ch
      i = j
    } else letters = letters ch
  }
  if (index(letters, "$")) report(c, loc, "takes its options from a variable", text)
  else if (letters ~ /[tTkKxX]/)
    report(c, loc, "option t, T, k, K, x or X hands a party a transfer, park or recording", text)
}

# context^exten^priority[(args)]; U names only a context and starts at s,1.
function handler(c, loc, text, group,   is_u, n, parts, target, ext) {
  n = tsplit(group, parts, "^")
  target = c
  ext = ""
  if (is_u) target = parts[1]
  else if (n >= 3) {
    target = parts[1]
    ext = parts[2]
  } else if (n == 2) ext = parts[1]
  if (index(ext, "$")) report(c, loc, "runs a handler at an extension named by a variable", text)
  if (trim(target) != "") reach(c, loc, text, target)
}

function queue(c, loc, text, args,   n, parts) {
  n = tsplit(args, parts, ",")
  if (n >= 2) options(c, loc, text, parts[2])
}

function assignment(c, loc, text, args,   low, eq) {
  low = tolower(args)
  if (low ~ /(^|,)[[:space:]]*_?_?handset=/)
    report(c, loc, "rebinds HANDSET, which decides whose phone rings", text)
  if (match(low, /channel\(hangup_handler_(push|wipe)\)=/)) {
    eq = RSTART + RLENGTH
    label(c, loc, text, substr(args, eq))
  }
}

function curlopt(c, loc, text,   low, rest, value, offset) {
  low = tolower(text)
  offset = 0
  while (match(substr(low, offset + 1), /curlopt\((conntimeout|httptimeout)\)=/)) {
    offset += RSTART + RLENGTH - 1
    value = substr(text, offset + 1)
    sub(/[),].*/, "", value)
    value = trim(value)
    if (value !~ /^[0-9]+(\.[0-9]+)?$/ || value + 0 >= 5)
      report(c, loc, "CURLOPT timeouts are seconds; '" value "' must be a literal under 5", text)
  }
}
