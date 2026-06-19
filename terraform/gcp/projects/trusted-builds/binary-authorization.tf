resource "google_binary_authorization_attestor" "provenance" {
  name        = "provenance"
  description = "Ensures the image is being built in a trusted GCP project, has been built by a trusted identity, and the built artifact checksum matches the image being deployed"

  attestation_authority_note {
    note_reference = google_container_analysis_note.provenance.name
    public_keys {
      comment = "Next-gen KMS key"

      pkix_public_key {
        public_key_pem      = data.google_kms_crypto_key_latest_version.signer.public_key[0].pem
        signature_algorithm = data.google_kms_crypto_key_latest_version.signer.public_key[0].algorithm
      }

      #   ascii_armored_pgp_public_key = <<-EOF
      #     -----BEGIN PGP PUBLIC KEY BLOCK-----

      #     mQINBFtOk4wBEAD1/nW11kKI+FSvYwlMsuJrNhfAcqFkObijWzjoprBbf14fxmSq
      #     IMKzt/U7A8Y2kNw8mXkheRfIKwfYcdFdbYeD6FJmhHgFPv/o7Y/eutH3aK7bxmNP
      #     kCRjfgTYHJ6DBj5G6EbsIhTTo+zR6dyAglR4MqixlbvyaedODr3BalOXzFWVxzQy
      #     C4myKsDvoxoE1t0oPmsLlGdabt/NqGNgIwJ11yraoaG5wWxfNr1TrvQNXTH9nTay
      #     Bp6cVuW+mIPK36COAnm9nQnz0W03S9oeI+pcQqAl1N0fA5zk/3MeW458XYUAlInB
      #     GZHP0YoIJVyYlqcNTu1ew/ZZX5cOn1su7Nk1Cb2YIgK7OE/QAkx/1derO9IvKMvQ
      #     b5o59TQZrw/ZY6eNkoA6EfuzmkNBJpvUxEd0fiZK2T0xooPTCnsi5kj6lavVO5IM
      #     hIhmQuZzqfML8NgAfBRYwpuXQ8MBnlf0/gZk3MKoTz9frET/2dWzegeukvK1jaLa
      #     kL1nJiNn0GXDjExwJ/FIC8Wataex/bODYEr/GZ5c2FM/6dfrxwh78iziB1Xa7pLu
      #     3YNfogKl7kZvmqRClGCccq9SO+kBq5/AwJu/oQ0y2wXHAvtbcwWDeNii2eI7X8ql
      #     EmkatqKwkQINNNco7W4+snAY/KjDVXPUsZDHBUYXs2U1uPb9uQfOe2v5KwARAQAB
      #     tC5UcnVzdGVkIEJ1aWxkIDx0cnVzdGVkLWJ1aWxkQGRlbW8uc2hvcGlmeS5jb20+
      #     iQJOBBMBCgA4FiEECh7GUIsu4OBk9M2676ggDgxJRsgFAltOk4wCGy8FCwkIBwMF
      #     FQoJCAsFFgIDAQACHgECF4AACgkQ76ggDgxJRsjHCA/7BCFzO/mxgC2kdIvnaWSo
      #     NvQn5YvbEuv7byUz9pUlp+AkB/HznGrjLgknpWezAeeFv9NdVIjVD1GA8Y3qmcHY
      #     iQ9J05+MdLMvk5BLE3//pOsZaUN28k1hsJs/0SLt3hlZ5/4YUNfw6baP6bJkumkr
      #     tPaa+x90jyzCLIDrADv/0SYZg+8EaKsbRuZvxuc2R8u0Dd/zNCRpAw+vli7J6Xpc
      #     d4uAtrrKAPFgfomP3epJ4ryf4tReXQZD99ttZmCFBoE0kh0LuqXzzMBfYJqwbtB8
      #     Sxipsi6sTSFZTB8gLilrEYiIwe3K9xZPDObyibr9hPVHiVcJhxPcKgfl2lfJIgfW
      #     lzDYsOobQjYeHpVrQnHfM/ruOIA0aGtbdPxAvimEBFxaPap+7H/CEY9qJ/3W4f+b
      #     Nb1FOKz4cXhzHXNQDF0nMDVcFmHsj6NWHvo3Rh+pmlrfV6jB4JBV2sj1RJYDzMVk
      #     FDZOG3t+ytpgvZbsXeFIqjXuCWTNruYstavt/eH7ZgWw1Ju54EFLawBJzLK2YLes
      #     K3kRVXCBiptx5GDQe8vT03CjSYYXL4648TL3jdC6ExnT8zqhnoZfAF/mWXDYWpxr
      #     o2J3k+gBlODxK1LnGrSarLtrGuFY0J1cekzkvTnphuFUtFyUQMGWxT7yGvHrnVxr
      #     PrqVGixsJIiTR4wpd3fRNIk=
      #     =1bSH
      #     -----END PGP PUBLIC KEY BLOCK-----
      #   EOF
    }
  }
}

resource "google_binary_authorization_attestor_iam_binding" "provenance" {
  project  = google_binary_authorization_attestor.provenance.project
  attestor = google_binary_authorization_attestor.provenance.name
  role     = "roles/binaryauthorization.attestorsViewer"
  members  = local.attester_principals
}

data "google_kms_crypto_key_latest_version" "signer" {
  crypto_key = google_kms_crypto_key.signer.id
}

resource "google_container_analysis_note" "provenance" {
  name = "provenance"
  attestation_authority {
    hint {
      human_readable_name = "Attestation Authority: Trusted Build (Provenance)"
    }
  }
}

data "google_iam_policy" "provenance" {
  binding {
    role    = "roles/containeranalysis.notes.attacher"
    members = local.attester_principals
  }
}

resource "google_container_analysis_note_iam_policy" "provenance" {
  project     = google_container_analysis_note.provenance.project
  note        = google_container_analysis_note.provenance.name
  policy_data = data.google_iam_policy.provenance.policy_data
}