# Reads `ari show users` as Asterisk 22 prints it (res/ari/cli.c: the header
# "r/o?  Username", a rule, then one "%-4s  %s" row per user) and exits 1
# unless it lists at least one user and every one is read-only. It prints the
# users, or what is wrong. Anything else, "Error getting ARI configuration"
# included, lacks the header and fails.
NR == 1 { header = ($1 == "r/o?" && $2 == "Username"); next }
NR == 2 || NF == 0 { next }
{
  users = users (users == "" ? "" : " ") $2
  if ($1 != "Yes") writable = writable (writable == "" ? "" : " ") $2
}
END {
  if (!header) { print "not the output of ari show users"; exit 1 }
  if (writable != "") { print "users that can write: " writable; exit 1 }
  if (users == "") { print "no users"; exit 1 }
  print users
}
