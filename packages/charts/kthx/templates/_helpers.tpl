{{/*
The names are fixed rather than derived from the release.

`kthx` is a Google IAM fact before it is a Helm one: the workload identity
binding in `terraform/gcp/projects/bluenose` names the principal
`offsite:system:serviceaccount:kthx:kthx`, so a ServiceAccount called anything
else federates with nothing and every depot read and write 403s. A
`fullnameOverride` would be a knob whose only correct setting is the default.
*/}}
{{- define "kthx.fullname" -}}kthx{{- end }}
{{- define "kthx.databaseName" -}}kthx-db{{- end }}

{{/*
`helm.sh/chart` is deliberately absent from every object here.

This chart is reconciled `Revision` from the in-repo GitRepository, so
source-controller stamps the git head sha into `.Chart.Version` — it changes on
every commit to main, not when this chart changes. On a pod template that is a
new pod-template-hash and a full rollout several times a day; on a single-replica
`Recreate` Deployment holding a ReadWriteOnce volume, each one is downtime.
Prowler learned this the expensive way (`packages/charts/prowler/templates/_helpers.tpl`).
*/}}
{{- define "kthx.labels" -}}
app.kubernetes.io/name: {{ include "kthx.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "kthx.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kthx.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
The federation mount, shared by the server and the nightly upload: a projected
ServiceAccount token for this cluster's issuer, beside the `external_account`
document that points at it.
*/}}
{{- define "kthx.gcpVolume" -}}
- name: gcp-federation
  projected:
    sources:
      - serviceAccountToken:
          audience: {{ .Values.gcp.audience | quote }}
          expirationSeconds: {{ .Values.gcp.expirationSeconds }}
          path: gcp-token
      - configMap:
          name: {{ include "kthx.fullname" . }}-gcp
{{- end }}

{{- define "kthx.gcpVolumeMount" -}}
- name: gcp-federation
  mountPath: {{ .Values.gcp.tokenMountPath }}
  readOnly: true
{{- end }}

{{- define "kthx.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end }}

{{/*
Pod Security Admission is `restricted` on this namespace, so nothing here may
fall back to a default: an image that declares its own uid is not enough.
*/}}
{{- define "kthx.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end }}
