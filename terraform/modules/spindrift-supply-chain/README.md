# spindrift-supply-chain

The supply chain one artifacts project holds for every Spindrift vessel: the
KMS signing key, the Binary Authorization attestor with its
container-analysis note, the build/log/occurrence project grants, and the
reader/writer members on an Artifact Registry repository the caller names.
The repository itself is an input, never created here — it may be shared
with non-Spindrift consumers, so it stays declared where it lives.

Two postures:

- **Auto (all defaults).** The module provisions the key ring, signer key,
  attestor, note, and every grant. Its `attestor` output is what
  `terraform/modules/spindrift-vessel`'s `attestor` variable takes;
  `signer_uri` and `registry_namespace` are what the installation manifest's
  `supplyChain` block names.
- **Bring your own.** Pass `signer_key` (full crypto key resource id) and/or
  `attestor` (`projects/*/attestors/*`). The module creates neither but
  still attaches every grant that coherently can attach to the provided
  resource: key grants attach by resource id, so a bring-your-own key still
  gets its `signerVerifier`/`viewer` members. What the caller arranges
  instead:
  - **Own key, another project:** the controller's project-scope
    `roles/cloudkms.viewer` (the SIGNER_KEY probe) only covers this module's
    project — mirror it where the key lives. The identity running the plan
    also needs `roles/cloudkms.viewer` on the key, for the latest-version
    read the attestor makes.
  - **Own attestor:** all attestor- and note-side IAM lives with it —
    `attestorsViewer` for the attesters, `attestorsVerifier` for each
    vessel's Binary Authorization service agent, `notes.attacher` for the
    attesters and `notes.occurrences.viewer` for the agents on its note
    (including the attestor project's own agent — on a created attestor the
    module composes that grant itself).
    If its occurrences record outside this module's project, mirror the
    `occurrences.editor` grant there too.
  - **Own attestor, created key:** the registration is the caller's, and the
    module hands over everything it takes — `signer_key_version_uri` as the
    public key id, `signer_public_key_pem`, and
    `signer_public_key_algorithm`. Only when both the key and the attestor
    are brought do those outputs go null.

Every grant is an additive `*_iam_member`; the module never owns the full
policy on the key, attestor, or note, so nothing brought in is stomped.

Nothing carries `prevent_destroy` — this module is the rebuild surface, and
teardown must stay cheap. GCP itself refuses to delete KMS rings and keys: a
destroy orphans them, and a rebuild in the same project either imports the
orphans or picks fresh `key_ring_name`/`signer_key_name` values.

The very first apply on a fresh key can fail reading its public half — the
version can still be `PENDING_GENERATION` when the attestor registration
reads it. The second apply converges; that retry is the procedure, not a
defect.

`examples/` holds one validating caller per posture: `auto`,
`bring-your-own`, and the two mixed postures `byo-key` and `byo-attestor`.

Pass `attester_principals` (and the other principal lists) as locals
declared in the calling root, for the same reason `spindrift-vessel` takes
`services` and `controller_roles` from the root's files: the root is where
an operator looks to see who may sign, and where generated remediation
stanzas grep. Required APIs (`cloudkms`, `binaryauthorization`,
`containeranalysis`, `artifactregistry`, `cloudbuild`) stay in the root's
`services.tf` for the same reason.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.11.0 |
| <a name="requirement_google"></a> [google](#requirement\_google) | >= 7.0.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_google"></a> [google](#provider\_google) | >= 7.0.0 |

## Modules

No modules.

## Resources

| Name | Type |
| ---- | ---- |
| [google_artifact_registry_repository_iam_member.reader](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository_iam_member) | resource |
| [google_artifact_registry_repository_iam_member.writer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/artifact_registry_repository_iam_member) | resource |
| [google_binary_authorization_attestor.provenance](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/binary_authorization_attestor) | resource |
| [google_binary_authorization_attestor_iam_member.verifier](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/binary_authorization_attestor_iam_member) | resource |
| [google_binary_authorization_attestor_iam_member.viewer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/binary_authorization_attestor_iam_member) | resource |
| [google_container_analysis_note.provenance](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/container_analysis_note) | resource |
| [google_container_analysis_note_iam_member.attacher](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/container_analysis_note_iam_member) | resource |
| [google_container_analysis_note_iam_member.occurrences_viewer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/container_analysis_note_iam_member) | resource |
| [google_kms_crypto_key.signer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_crypto_key) | resource |
| [google_kms_crypto_key_iam_member.signer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_crypto_key_iam_member) | resource |
| [google_kms_crypto_key_iam_member.signer_metadata](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_crypto_key_iam_member) | resource |
| [google_kms_key_ring.keys](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_key_ring) | resource |
| [google_project_iam_member.attester_occurrences](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_iam_member.controller_build_logs](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_iam_member.controller_builds](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_project_iam_member.controller_probe_viewer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_iam_member) | resource |
| [google_kms_crypto_key_latest_version.signer](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/kms_crypto_key_latest_version) | data source |
| [google_project.this](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/project) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_attester_principals"></a> [attester\_principals](#input\_attester\_principals) | Everything that signs with the attestor's key — one principal per build route that can reach a Target enforcing Binary Authorization. Declare the list as a local in the calling root so an operator reading the root sees who may sign. | `list(string)` | n/a | yes |
| <a name="input_attestor"></a> [attestor](#input\_attestor) | Existing Binary Authorization attestor, as projects/*/attestors/*. Set it and the module creates no attestor, note, or IAM on either — the caller arranges those grants where the attestor lives (see README). | `string` | `null` | no |
| <a name="input_attestor_viewers"></a> [attestor\_viewers](#input\_attestor\_viewers) | Members granted attestorsViewer beyond the attesters themselves (e.g. the Terraform service account) | `list(string)` | `[]` | no |
| <a name="input_controller_member"></a> [controller\_member](#input\_controller\_member) | The IAM member the Spindrift controller acts as | `string` | n/a | yes |
| <a name="input_key_ring_name"></a> [key\_ring\_name](#input\_key\_ring\_name) | Name of the KMS key ring the module creates. GCP never deletes rings or keys — a rebuild in a project holding an orphaned ring either imports it or picks a fresh name here. | `string` | `"keys"` | no |
| <a name="input_location"></a> [location](#input\_location) | Location of the KMS key ring and of the Artifact Registry repository the grants attach to | `string` | n/a | yes |
| <a name="input_project"></a> [project](#input\_project) | The artifacts project the supply chain lives in | `string` | n/a | yes |
| <a name="input_registry_readers"></a> [registry\_readers](#input\_registry\_readers) | Members granted artifactregistry.reader on the repository — per-vessel pull principals (the vessel's Binary Authorization and serverless robot service agents, the controller). | `list(string)` | `[]` | no |
| <a name="input_registry_writers"></a> [registry\_writers](#input\_registry\_writers) | Members granted artifactregistry.writer on the repository. Defaults to the attesters: every route that signs also pushes, and a cosign signature is itself an object in the repository. | `list(string)` | `null` | no |
| <a name="input_repository"></a> [repository](#input\_repository) | Artifact Registry repository id the reader/writer grants attach to. The module never creates it — the repository may be shared with non-Spindrift consumers, so it stays declared where it lives. | `string` | n/a | yes |
| <a name="input_signer_key"></a> [signer\_key](#input\_signer\_key) | Existing KMS crypto key to sign with, as its full resource id (projects/*/locations/*/keyRings/*/cryptoKeys/*). Set it and the module creates no ring or key, only the grants on the one provided. | `string` | `null` | no |
| <a name="input_signer_key_name"></a> [signer\_key\_name](#input\_signer\_key\_name) | Name of the signer crypto key inside the ring. Same unremovability caveat as the ring. | `string` | `"signer"` | no |
| <a name="input_verifier_agents"></a> [verifier\_agents](#input\_verifier\_agents) | Binary Authorization service agents of the vessels that verify admission against the attestor. Empty on first bootstrap — a vessel's agent exists only after its Binary Authorization API is enabled; add each agent once its vessel does. The attestor project's own agent gets its note read automatically; this list is only the vessels'. | `list(string)` | `[]` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_attestor"></a> [attestor](#output\_attestor) | Binary Authorization attestor id (projects/*/attestors/*) — what terraform/modules/spindrift-vessel's attestor variable takes |
| <a name="output_note"></a> [note](#output\_note) | Container-analysis note id (projects/*/notes/*). Null with a bring-your-own attestor. |
| <a name="output_registry_namespace"></a> [registry\_namespace](#output\_registry\_namespace) | Artifact Registry namespace Spindrift publishes to — supplyChain.registry material. A namespace, not a repository: core appends {app}/{component}. |
| <a name="output_signer_key"></a> [signer\_key](#output\_signer\_key) | Signer crypto key resource id (projects/*/locations/*/keyRings/*/cryptoKeys/*) |
| <a name="output_signer_key_version_uri"></a> [signer\_key\_version\_uri](#output\_signer\_key\_version\_uri) | Latest key version as //cloudkms.googleapis.com/v1/… — the public key id the attestor registers and sign-and-create stamps. Null only when both the key and the attestor are brought; a bring-your-own attestor paired with a created key takes this to register it. |
| <a name="output_signer_public_key_algorithm"></a> [signer\_public\_key\_algorithm](#output\_signer\_public\_key\_algorithm) | Signature algorithm of that version, as Binary Authorization's pkix registration wants it. Null only when both the key and the attestor are brought. |
| <a name="output_signer_public_key_pem"></a> [signer\_public\_key\_pem](#output\_signer\_public\_key\_pem) | PEM public half of the latest key version — what a bring-your-own attestor registers for a module-created key. Null only when both the key and the attestor are brought. |
| <a name="output_signer_uri"></a> [signer\_uri](#output\_signer\_uri) | The key as the installation manifest's supplyChain.signer names it: gcpkms:// prefixed to the key's resource id |
<!-- END_TF_DOCS -->
