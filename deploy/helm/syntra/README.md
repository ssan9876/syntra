# Syntra Helm chart

This chart deploys the Syntra API and web application. It deliberately expects
the runtime secret to exist already: credentials and encryption material do not
belong in a chart values file or a Helm release history.

Install one release in a dedicated namespace. The web image proxies API calls
to the in-namespace `api` Service, so sharing a namespace between releases is
not supported.

```powershell
kubectl create namespace syntra
kubectl -n syntra create secret generic syntra-runtime `
  --from-literal=DATABASE_URL='postgresql://...' `
  --from-literal=PUBLIC_URL='https://syntra.example.com' `
  --from-literal=SESSION_SECRET='...' `
  --from-literal=MASTER_KEY='...' `
  --from-literal=SMTP_URL='...' `
  --from-literal=METRICS_TOKEN='...'
helm upgrade --install syntra .\deploy\helm\syntra --namespace syntra
```

Set immutable image tags, appropriate resource requests/limits, and an
Ingress or gateway in the environment-specific values file. By default, the
chart runs a pre-install/pre-upgrade migration Job from the API image; set
`migration.enabled: false` only when migrations are controlled separately.
The API pod has
no Kubernetes service-account token and runs as non-root with all Linux
capabilities dropped. Apply database
migrations before rolling out an image that requires a newer schema.
