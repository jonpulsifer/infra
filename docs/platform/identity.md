---
title: Identity
description: SPIRE workload identity in the trust domain lolwtf.ca, and how a workload trades a JWT-SVID for GCP access with no key file.
---

SPIRE gives each workload on a TPM node an identity in the trust domain `lolwtf.ca`. The SPIFFE ID of a workload is `spiffe://lolwtf.ca/ns/<namespace>/sa/<serviceaccount>` on either cluster. With it, a workload reaches GCP with no key file and no grant tied to a cluster.

## GCP access

| Part | Job | Where it runs |
| --- | --- | --- |
| `oidc-discovery-provider` | Publishes the keys that check JWT-SVIDs, as the issuer `https://spire.lolwtf.ca` | A pod in `spire-oidc` on folly, on a node labelled `lolwtf.ca/tpm=true` |
| folly Cloudflare Tunnel | Serves `/.well-known/openid-configuration` and `/keys` on `spire.lolwtf.ca`, and no other path | Cloudflare, to the provider's Service |
| `fml-pool` provider `spire` | Trades a JWT-SVID for a GCP token. The subject is the SPIFFE ID. | GCP |

A workload gets GCP access in four steps.

1. The SPIRE server registers its SPIFFE ID.
2. A grant in `terraform/gcp/projects/homelab-ng/` names the principal `principal://iam.googleapis.com/<fml-pool>/subject/spiffe://lolwtf.ca/ns/<namespace>/sa/<serviceaccount>`.
3. The pod mounts the agent socket from `/run/spire/sockets` and runs `spire-agent api fetch jwt`. The audience is the provider's full resource name, `//iam.googleapis.com/<fml-pool>/providers/spire`.
4. The pod writes the SVID to a file and an `external_account` credential config whose `credential_source` is that file. The config has no `service_account_impersonation_url`, so GCP sees the SPIFFE ID itself. `gcloud auth login --cred-file` or a Google client library reads it.

`<fml-pool>` is `projects/<project-number>/locations/global/workloadIdentityPools/fml-pool`. A JWT-SVID is short-lived, so a long-running workload rewrites the file before it expires.

The test is the Job in `clusters/folly/apps/spire-test/`. It runs as `spire-test/uploader`, which holds only `roles/storage.objectCreator` on the bucket `homelab-ng-spire-test`. Its log names the SPIFFE ID and the object it wrote. Bump the suffix of the Job's name to run it again. The bucket deletes objects after seven days.

## Rules

- The provider admits every SPIFFE ID in the trust domain. Grant on one subject, never on the pool or on `attribute.spiffe_id` with a prefix.
- The SPIRE server's `jwt_issuer`, the discovery provider's `jwt_issuer` and the pool provider's `issuer_uri` are one value, `https://spire.lolwtf.ca`. GCP rejects an SVID whose `iss` differs.
- The discovery provider reads its keys through the agent's Workload API, which serves only a registered workload. Its entry is `spiffe://lolwtf.ca/ns/spire-oidc/sa/oidc-discovery-provider`. Without it, `spire.lolwtf.ca` serves no keys and every exchange fails.
- `iam.workloadIdentityPoolProviders` in `terraform/gcp/projects/homelab-ng/policy.tf` lists the issuer. A new issuer needs an entry there first.

## Where it lives

- `clusters/folly/apps/spire-oidc/`: the discovery provider
- `clusters/folly/apps/spire-test/`: the upload test
- `terraform/network/cloudflare/lolwtf.ca.tf`: the tunnel rule for `spire.lolwtf.ca`
- `terraform/gcp/projects/homelab-ng/workload-identity.tf`: the provider `spire` in `fml-pool`
- `terraform/gcp/projects/homelab-ng/spire-test.tf`: the test bucket and its grant

## Related

- [PKI](pki.md#workload-identity): the cluster ServiceAccount issuers in the same pool
- [Cloud](cloud.md)
