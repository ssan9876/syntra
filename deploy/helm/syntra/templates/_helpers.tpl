{{/*
Names. `fullname` prefixes every resource the chart owns, EXCEPT the API
Service, which must be called exactly `api`: the web image's nginx.conf
proxies to http://api:3000, so one release per namespace.
*/}}
{{- define "syntra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "syntra.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "syntra.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Selector labels. These three -- and only these -- are what chart 0.1 used as
Deployment selectors, which are immutable; keep them identical so an upgrade
from 0.1 does not need the Deployments deleted first. Call with
(dict "ctx" $ "component" "api").
*/}}
{{- define "syntra.selectorLabels" -}}
app.kubernetes.io/name: syntra
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "syntra.labels" -}}
{{ include "syntra.selectorLabels" . }}
helm.sh/chart: {{ include "syntra.chart" .ctx }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/part-of: syntra
{{- end -}}

{{- define "syntra.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "syntra.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
An image reference from {repository, tag, digest}. A digest wins over a tag;
an empty tag falls back to the chart's appVersion. Call with
(dict "image" .Values.api.image "ctx" $).
*/}}
{{- define "syntra.image" -}}
{{- if .image.digest -}}
{{- printf "%s@%s" .image.repository .image.digest -}}
{{- else -}}
{{- printf "%s:%s" .image.repository (default .ctx.Chart.AppVersion (toString .image.tag)) -}}
{{- end -}}
{{- end -}}

{{/*
The runtime Secret's name. Fails the render -- rather than falling back to a
guessed name -- when neither an existing Secret nor a chart-created one is
configured: a Deployment pointing at a Secret that does not exist installs
"successfully" and then sits in CreateContainerConfigError.
*/}}
{{- define "syntra.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else if .Values.secret.create -}}
{{- printf "%s-runtime" (include "syntra.fullname" .) -}}
{{- else -}}
{{- required "Set existingSecret to the name of a Secret holding DATABASE_URL, SESSION_SECRET, MASTER_KEY and SMTP_URL (see the chart README), or set secret.create=true for a disposable environment." .Values.existingSecret -}}
{{- end -}}
{{- end -}}

{{/* Required, non-secret configuration, checked once. */}}
{{- define "syntra.validate" -}}
{{- if and (not .Values.publicUrl) (not .Values.secretKeys.publicUrl) -}}
{{- fail "Set publicUrl to the origin users type, e.g. https://idm.example.com" -}}
{{- end -}}
{{- if and .Values.publicUrl (not (regexMatch "^https?://" .Values.publicUrl)) -}}
{{- fail "publicUrl must be an absolute http(s) URL, e.g. https://idm.example.com" -}}
{{- end -}}
{{- if and .Values.api.trustProxy (or (eq (lower (toString .Values.api.trustProxy)) "true") (regexMatch "^[0-9]+$" (toString .Values.api.trustProxy))) -}}
{{- fail "api.trustProxy must be addresses or CIDRs (e.g. 10.244.0.0/16), never `true` or a hop count; the API refuses both at startup" -}}
{{- end -}}
{{- if and .Values.secret.create (not .Values.existingSecret) -}}
{{- range $k := list .Values.secretKeys.databaseUrl .Values.secretKeys.sessionSecret .Values.secretKeys.masterKey .Values.secretKeys.smtpUrl -}}
{{- if not (hasKey $.Values.secret.data $k) -}}
{{- fail (printf "secret.create is true but secret.data has no %s" $k) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* A secretKeyRef env entry. Call with (dict "name" "X" "secret" $s "key" $k "optional" bool). */}}
{{- define "syntra.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}

{{/*
Default spreading: across nodes, and across zones where the cluster has them.
Both soft (ScheduleAnyway) so a small cluster still schedules.
*/}}
{{- define "syntra.topologySpread" -}}
{{- $component := .component -}}
{{- $ctx := .ctx -}}
{{- if .override -}}
{{- toYaml .override -}}
{{- else -}}
- maxSkew: 1
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "syntra.selectorLabels" (dict "ctx" $ctx "component" $component) | nindent 6 }}
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "syntra.selectorLabels" (dict "ctx" $ctx "component" $component) | nindent 6 }}
{{- end -}}
{{- end -}}

{{/*
One egress rule per {cidrs, ports} entry. The metadata-service exclusions are
applied only to the catch-all ranges: an `except` must lie inside its `cidr`,
and 169.254.169.254 is not inside, say, 10.0.0.0/8.
*/}}
{{- define "syntra.np.cidrRule" -}}
- to:
    {{- range .rule.cidrs }}
    - ipBlock:
        cidr: {{ . }}
        {{- if eq . "0.0.0.0/0" }}
        {{- $v4 := list }}
        {{- range $.except }}{{ if not (contains ":" .) }}{{ $v4 = append $v4 . }}{{ end }}{{ end }}
        {{- with $v4 }}
        except:
          {{- toYaml . | nindent 10 }}
        {{- end }}
        {{- else if eq . "::/0" }}
        {{- $v6 := list }}
        {{- range $.except }}{{ if contains ":" . }}{{ $v6 = append $v6 . }}{{ end }}{{ end }}
        {{- with $v6 }}
        except:
          {{- toYaml . | nindent 10 }}
        {{- end }}
        {{- end }}
    {{- end }}
  ports:
    {{- range .rule.ports }}
    - { protocol: TCP, port: {{ . }} }
    {{- end }}
{{- end -}}
{{- define "syntra.np.dns" -}}
- to:
    - namespaceSelector:
        {{- toYaml .namespaceSelector | nindent 8 }}
      podSelector:
        {{- toYaml .podSelector | nindent 8 }}
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
{{- end -}}
