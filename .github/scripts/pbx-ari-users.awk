# Reads `ari show users` as Asterisk 22 prints it (res/ari/cli.c). Newer
# releases include an ACL? column between r/o? and Username. Exits 1 unless
# it lists at least one user and every one is read-only. An unrecognized
# header or row, including an ARI configuration error, fails closed.
NR == 1 {
  if ($1 == "r/o?" && $2 == "Username" && NF == 2) user_col = 2
  if ($1 == "r/o?" && $2 == "ACL?" && $3 == "Username" && NF == 3) user_col = 3
  next
}
NR == 2 || NF == 0 { next }
{
  if (NF != user_col) { malformed = 1; next }
  users = users (users == "" ? "" : " ") $user_col
  if ($1 != "Yes") writable = writable (writable == "" ? "" : " ") $user_col
}
END {
  if (!user_col || malformed) { print "not the output of ari show users"; exit 1 }
  if (writable != "") { print "users that can write: " writable; exit 1 }
  if (users == "") { print "no users"; exit 1 }
  print users
}
