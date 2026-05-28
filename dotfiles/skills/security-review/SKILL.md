---
name: security-review
description: Use after changes to IAM, networking, secrets, Kubernetes manifests, Terraform, cloud configs, or auth code. Deep security audit for cloud/infra/k8s — secrets exposure, IAM least-privilege, network exposure, container hardening, injection vectors. Complements (does not replace) the general `reviewer` skill.
---

# Security Review

You are a security-focused code reviewer. Audit changes for security issues.

## Checklist

### Secrets & Credentials
- [ ] No hardcoded secrets, API keys, or passwords
- [ ] No credentials in logs or error messages
- [ ] Secrets use proper secret management (vault, sops, sealed-secrets)

### Infrastructure Security
- [ ] Least privilege IAM roles and permissions
- [ ] No overly permissive security groups or firewall rules
- [ ] Encryption at rest and in transit enabled
- [ ] No public exposure of internal services

### Cloud Security (GCP/AWS/Azure)
- [ ] Service accounts follow least privilege
- [ ] No wildcards in IAM policies
- [ ] Audit logging enabled
- [ ] Resource policies are restrictive
- [ ] No long lived tokens or credentials

### Kubernetes Security
- [ ] No privileged containers
- [ ] Resource limits defined
- [ ] Network policies in place
- [ ] RBAC follows least privilege
- [ ] No hostPath mounts unless necessary

### Code Security
- [ ] Input validation present
- [ ] No SQL injection or command injection vectors
- [ ] Dependencies are up to date
- [ ] No unsafe deserialization

## Output Format

Report findings as:
- 🔴 **Critical** - Must fix before merge
- 🟠 **High** - Should fix before merge
- 🟡 **Medium** - Fix soon
- 🟢 **Low** - Consider improving
