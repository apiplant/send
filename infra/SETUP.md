# Deployment — server backend only, on the Oracle k3s cluster

The signalling server runs in the `send` namespace of the Oracle cluster
(`~/.kube/oracle-1`), the same cluster metripact uses. The web app is hosted
separately on `send.apiplant.com` and calls this backend cross-origin at
`send-api.apiplant.com` (the server already returns permissive CORS headers).

There is no database, volume, or Tailscale sidecar — signalling state is
in-memory and short-lived.

## One-time bootstrap (cluster admin)

```sh
export KUBECONFIG=~/.kube/oracle-1

# Namespace + RBAC for the in-cluster GitLab runner to deploy.
kubectl apply -f infra/namespace.yaml -f infra/gitlab-runner-rbac.yaml   # done

# Registry pull secret — copy the one metripact already uses.
kubectl -n metripact get secret regcred -o yaml \
  | sed 's/namespace: metripact/namespace: send/' \
  | kubectl apply -n send -f -

# First rollout (CI does this on every subsequent push to the default branch).
kubectl apply -f infra/deployment.yaml -f infra/service.yaml -f infra/ingress.yaml
```

Then point a DNS record for `send-api.apiplant.com` at the cluster ingress
(Cloudflare-proxied, which also terminates TLS — the Ingress has no tls stanza).

## CI

`.gitlab-ci.yml` builds `registry.gitlab.com/apiplant/send/server` for
`linux/arm64` and deploys it. The runner is in-cluster and authenticates with
its ServiceAccount token — no kubeconfig in CI. Jobs only run on the default
branch when `server/**` or the applied `infra/*.yaml` files change.

## Config (env on the Deployment)

| Variable | Value | Meaning |
| --- | --- | --- |
| `APIPLANT_SEND_ADDR` | `0.0.0.0:8080` | listen address |
| `APIPLANT_SEND_STATIC` | `/nonexistent` | disables the static host (signalling only) |
| `APIPLANT_SEND_TTL` | `3600` | seconds an idle session is kept |
| `APIPLANT_SEND_ENCRYPTION` | `required` | end-to-end encryption policy |
| `APIPLANT_SEND_TURN` | _(unset)_ | JSON array of `RTCIceServer` objects appended to STUN; served at `/api/turn` |

## TURN relay

The app is served at `/api/turn` a STUN server plus whatever `APIPLANT_SEND_TURN`
holds. STUN alone is enough only when at least one peer has a non-symmetric NAT;
most mobile carriers (5G/LTE) use symmetric CGNAT, so **without a TURN relay a
phone on cellular cannot receive from a machine on another network**.

The relay is not deployed yet. To add one, create the `send-turn` secret with a
JSON array under `ice-servers` and restart the deployment:

```sh
export KUBECONFIG=~/.kube/oracle-1
kubectl -n send create secret generic send-turn \
  --from-literal=ice-servers='[{"urls":["turn:turn.apiplant.com:3478?transport=udp","turns:turn.apiplant.com:5349?transport=tcp"],"username":"USER","credential":"PASS"}]'
kubectl -n send rollout restart deployment/server
```

`turns:` on TCP/443-or-5349 is the most firewall-proof transport — include it.
Relayed bytes stay end-to-end encrypted (DTLS + the per-transfer AES key); the
relay only sees ciphertext. Candidate backends: Cloudflare Realtime TURN, a
managed provider (Metered, Twilio), or self-hosted coturn on a public-IP box.
