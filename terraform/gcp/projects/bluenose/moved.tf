# Address renames from spindrift to kthx_engine. State moves; nothing is replaced.

moved {
  from = google_service_account.spindrift_controller
  to   = google_service_account.kthx_engine_controller
}

moved {
  from = google_service_account_iam_member.spindrift_controller_workload_identity
  to   = google_service_account_iam_member.kthx_engine_controller_workload_identity
}

moved {
  from = google_service_account_iam_member.spindrift_controller_token_creator
  to   = google_service_account_iam_member.kthx_engine_controller_token_creator
}

moved {
  from = google_service_account_iam_member.spindrift_controller_acts_as_default
  to   = google_service_account_iam_member.kthx_engine_controller_acts_as_default
}

moved {
  from = google_storage_bucket.spindrift_source
  to   = google_storage_bucket.kthx_engine_source
}

moved {
  from = google_storage_bucket_iam_member.spindrift_source
  to   = google_storage_bucket_iam_member.kthx_engine_source
}

moved {
  from = google_firebase_project.spindrift
  to   = google_firebase_project.kthx_engine
}
