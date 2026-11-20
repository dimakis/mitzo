# Mitzo observability

Loki stores structured operational logs, Jaeger stores runtime traces, Grafana
provides log dashboards and trace-ID viewing, and MLflow stores experiment runs,
learning metrics and artifacts. Setting `MLFLOW_TRACKING_URI` alone does not
record experiments: a learning/experiment producer must use the tracking API.
Infrastructure diagnostic runs are tagged `mitzo.purpose=infrastructure-diagnostic…`
and reported separately from application runs.

## Host startup and checks

Use an accepted, reviewed checkout and the explicitly authorized host. This is
independent of the retired staging system; these commands do not authorize a
production deployment or staging reactivation.

```sh
npm run observability:up
npm run observability:check
node scripts/observability-readback.mjs --require-recent
npm run tracing:up                  # Jaeger only, same storage/config lifetime
npm run observability:down          # stop; keep volumes and retained records
```

The startup helper uses a dedicated Compose project, `mitzo-observability`, with
no shared Podman pod. All four data volumes are external and have explicit names:
`mitzo-jaeger-data`, `mitzo-loki-data`, `mitzo-grafana-data`, `mitzo-mlflow-data`.
Podman creates missing volumes with the service UID/GID (10001/10001 for Loki and
Jaeger, 472/0 for Grafana, 0/0 for MLflow). Existing volumes are reused.

Configuration is frozen into verified, content-addressed snapshots under
`${XDG_DATA_HOME:-$HOME/.local/share}/mitzo-observability/configs/`. Override the
state directory with `MITZO_OBSERVABILITY_HOME`. Snapshots contain regular files,
never links back into a release. Extra or modified provisioned files fail the
integrity check. Release cleanup must preserve this state directory and the
external volumes. Do not prune the Podman machine or its volumes as deployment
cleanup. Named volumes survive container replacement; they do not replace backups.

The checker has an eight-second total request deadline. It queries actual Loki
logs and Jaeger v3 traces directly and through Grafana's data-source proxy, and
queries MLflow experiments/runs. Output contains counts, ages and sanitized
failure stage/cause, never log bodies, trace attributes or experiment names.
A normal check can succeed on a quiet new installation while reporting zero
recent records; `--require-recent` additionally requires data from the last five
minutes both directly and through Grafana. Recent run counts sample at most five
runs across the first twenty active experiments; they are not a historical total.

Readback success proves those reads, not future durability or producer activity.
Qualify a storage migration with a clearly tagged diagnostic log, a Grafana DB
write, an MLflow run/metric and HTTP artifact upload/download, then read the same
identities after a selected restart. No model calls are needed. Preserve the
results and distinguish these diagnostics from application learning runs.

## Grafana and remote clients

The existing Loki UID is explicitly pinned so retained dashboards and links
remain compatible. Log TraceID links open Grafana's Jaeger trace viewer, and
trace-to-log navigation filters by the same trace ID. Jaeger 2.21 uses the v3 API;
Grafana needs `jaegerEnableGrpcEndpoint`. Its supported trace-ID lookup works,
but the legacy Grafana search query still returns 404. The dashboard therefore
uses correlated logs plus **Search traces** in Jaeger's own UI, rather than a
broken recent-traces table. MLflow remains an experiment UI, not a runtime trace
store. Grafana plugin auto-updates at startup are disabled for repeatable operation.

Default dashboard links use host-local ports (Grafana 3002, Jaeger 16686, MLflow
5050). For another device, save reachable public URLs before startup in
`$MITZO_OBSERVABILITY_HOME/public-urls.json` (or the default state directory):

```json
{
  "jaegerUiUrl": "http://your-observability-host:16686",
  "mlflowUiUrl": "http://your-observability-host:5050"
}
```

`MITZO_JAEGER_UI_URL` and `MITZO_MLFLOW_UI_URL` override those values for one
invocation. Public URLs cannot contain credentials or query/fragment components.
The rendered URLs are part of the config fingerprint. They must be reachable
from the viewing device; browser `localhost` refers to that device.

## MLflow artifacts

The server uses an absolute SQLite database path, one worker, and HTTP artifact
proxying to `/mlflow/artifacts`. New experiments default to `mlflow-artifacts:/`,
so remote clients can upload/download through the tracking server. Existing
experiment artifact locations are retained by MLflow. Inventory their runs and
artifacts before migrating a legacy file URI; never rewrite populated experiment
locations without a separate qualified migration and backup. Use a named new
experiment for a newly connected learning producer.

## First migration from release-bound or manually started containers

Do not start empty replacement stores over existing history. The helper refuses
running legacy containers, and refuses creating a missing permanent volume while
any corresponding legacy container exists, including stopped containers.

1. Inventory the selected containers, image IDs, mounts, restart policy, network,
   databases and data owners. Preserve private inspect/log records and backups.
   A container export excludes bind-mounted data. If a release directory has
   already been deleted, keep the process running while investigating surviving
   handles and in-memory data; an ordinary restart may destroy the remaining copy.
2. Back up consistent selected databases/stores and verify restored copies before
   switching writers. Preserve SQLite integrity results, Loki index/chunk/WAL
   inventory and Jaeger store ownership. Record missing history honestly.
3. Import into the explicitly named external volumes with matching service
   ownership. Keep legacy containers and source data as retained diagnostic
   records; disable their automatic restart after the handoff.
4. Stop writers before a final consistent snapshot or shared-volume handoff.
   Retain/rename manually started `mitzo-*-persistent` containers before Compose
   creates its replacements. A matching name alone does not establish Compose
   ownership. Never use `--force-recreate`, remove the legacy pod, or prune other
   containers to get past a name/dependency collision.
5. Start the dedicated project using stable config snapshots. Verify actual
   readback, a tagged run/metric/artifact, a Grafana write and fresh application
   logs/traces. Re-read the same stored identities after replacement/restart.
   Finally run startup again and verify it reuses the same container IDs.

Backups and rollback records remain outside disposable releases. Rollback stops
the new writer before starting any retained writer against the same volume; no
two Grafana/MLflow/Badger processes may write the same store concurrently.
