# Address renames from spindrift to kthx_engine. State moves; nothing is replaced.

moved {
  from = google_secret_manager_secret.spindrift_build_seal_key
  to   = google_secret_manager_secret.kthx_engine_build_seal_key
}

moved {
  from = google_secret_manager_secret_iam_member.spindrift_build_seal_key_accessor
  to   = google_secret_manager_secret_iam_member.kthx_engine_build_seal_key_accessor
}
