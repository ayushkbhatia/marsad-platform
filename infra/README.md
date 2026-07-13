# Marsad VPS — owner provisioning runbook

One Hetzner **CX22** (2 vCPU / 4 GB / 40 GB, ~€4.35 + €0.50 IPv4 ≈ $5/mo,
owner-approved) runs the single `marsad-worker` process. The box is
**stateless**: everything durable lives in Supabase/R2, so a lost VM is
rebuilt from `infra/cloud-init.yaml` in ~10 minutes.

Files here:

| File | Purpose |
|---|---|
| `cloud-init.yaml` | Full VM recipe — paste into Hetzner at create time |
| `marsad-worker.service` | Canonical systemd unit (a copy is embedded in cloud-init; keep in sync) |

---

## 1. Before you create the server

You need three things ready to paste:

1. **Your personal SSH public key** (`~/.ssh/id_ed25519.pub` on your Mac; run
   `ssh-keygen -t ed25519` if you don't have one).
2. **A read-only GitHub deploy key** for the repo — see §2.
3. **The `marsad_worker` DB password** and the Supabase service-role key
   (Supabase dashboard → Project Settings → API). Keep both in your password
   manager.

## 2. Generate the GitHub deploy key

On your Mac:

```sh
ssh-keygen -t ed25519 -f marsad_deploy -N "" -C "marsad-worker-vps"
```

- GitHub → repo → **Settings → Deploy keys → Add deploy key**: paste
  `marsad_deploy.pub`, title `marsad-worker-vps`, leave **Allow write access
  unchecked** (read-only).
- Keep `marsad_deploy` (the private key) at hand for the next step; store a
  copy in your password manager, then delete both files from disk.

## 3. Create the server (Hetzner console)

1. <https://console.hetzner.cloud> → your project → **Add Server**.
2. **Location**: Falkenstein (fsn1) — any EU location is fine.
3. **Image**: Ubuntu 24.04.
4. **Type**: Shared vCPU (x86) → **CX22**.
5. **Networking**: check **Public IPv4** (the €0.50 add-on — required for the
   Supavisor pooler path and venue sites; 06 Revisions #1) and IPv6.
6. **SSH keys**: add/select your personal public key (this covers the root
   user; the `deploy` user gets it via cloud-init too).
7. Expand **Cloud config** (the "User data" text box) and paste the full
   contents of `infra/cloud-init.yaml`, after replacing in your paste:
   - `REPLACE_WITH_OWNER_SSH_PUBLIC_KEY` → your public key (one line),
   - `REPLACE_WITH_DEPLOY_PRIVATE_KEY` → the deploy **private** key. It is
     multi-line: indent every line of the key block to match the `content:`
     indentation (six spaces), including the BEGIN/END lines,
   - `OWNER/Marsad-Platform` → the real GitHub path (one occurrence, in
     `runcmd`).
8. **Name**: `marsad-worker-1` → **Create & Buy now**.
9. Wait ~5 minutes. Check progress: `ssh deploy@<server-ip>` then
   `cloud-init status --wait` (should end `status: done`).

## 4. Fill the worker environment and start

```sh
ssh deploy@<server-ip>
sudo nano /etc/marsad/worker.env
```

Replace every `CHANGE_ME`:

- `SUPABASE_DB_URL` — the `marsad_worker` connection string via the **session
  pooler**: Supabase dashboard → Connect → Session pooler, then substitute the
  user `marsad_worker.yjsncnpbjuueaoeejrqj` and its password.
- `SUPABASE_SERVICE_ROLE_KEY` — dashboard → Project Settings → API. Used only
  for Storage uploads.
- `HEALTHCHECK_URL` — create a check named `worker-alive` at
  <https://healthchecks.io> (free tier), period 5 minutes, grace 5 minutes;
  paste its ping URL. Optional but do it — a dead worker then emails you.

Then:

```sh
sudo systemctl start marsad-worker
sudo journalctl -u marsad-worker -f
```

Healthy boot looks like (JSON lines):

```
{"level":"info","msg":"marsad-worker booting",...}
{"level":"info","msg":"database connected","role":"marsad_worker",...}
{"level":"info","msg":"consumer started","queue":"q_ingest",...}   (x5 queues)
```

If it crash-loops, the journal shows why (bad DB URL/password is the usual
suspect); `Restart=always` retries every 5s, so just fix the env file and
`sudo systemctl restart marsad-worker`.

## 5. Verify the heartbeat

In the Supabase SQL editor (read-only query — the dashboard DDL ban does not
apply):

```sql
select job_name, last_run_at, last_ok_at, consecutive_failures
from ops.job_heartbeats
where job_name like 'worker:%'
order by job_name;
```

Expect 6 rows (`worker:alive` + one per queue) with `last_run_at` within the
last 30 seconds, refreshing on every re-run. End-to-end message test:

```sql
select pgmq.send('q_maintenance', '{"handler":"noop","hello":"vps"}'::jsonb);
```

then on the VPS, `journalctl -u marsad-worker -n 20` should show
`noop handler executed` and `message processed`.

## 6. Ongoing operations

| Task | How |
|---|---|
| Deploy new worker code | Automatic: `worker-deploy.yml` on pushes to `main` touching `worker/**` (rsync + `systemctl restart`). Manual fallback: `ssh deploy@<ip>`, `cd /opt/marsad && git pull && cd worker && npm install --no-audit --no-fund && npm run build && sudo systemctl restart marsad-worker` |
| Logs | `journalctl -u marsad-worker -f` (JSON lines) |
| Restart | `sudo systemctl restart marsad-worker` (SIGTERM drain: in-flight work gets 30s, the rest redelivers via pgmq vt) |
| OS patching | unattended-upgrades runs daily automatically |
| Rotate a secret | edit `/etc/marsad/worker.env`, `sudo systemctl restart marsad-worker` |
| Rebuild after total loss | Repeat §3–§5 on a fresh server; nothing on the box is unique. Delete the old server in the Hetzner console |

Security posture baked in: ufw allows **SSH only** (all worker traffic is
outbound), password SSH auth disabled, fail2ban on sshd, deploy key is
read-only, `worker.env` is root:root 0600.
