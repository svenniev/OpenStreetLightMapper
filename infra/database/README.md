# Local database (development only)

Standalone MongoDB Community server for OpenStreetLightMapper, running in
Docker on this machine. It stores workspaces (regions, selections, sessions,
detection items, evidence artifacts, reviewed results) so work survives
browser refresh and server/database restarts.

**Scope.** “Local database” does **not** make Mapillary, Overpass, basemap
tiles, or hosted SAM work offline. Saved work reopens without calling those
providers; new searches and new inference still need them. There is no cloud
database, no sync, no multi-user support, and no public binding.

**Security posture.** Authentication-free MongoDB published on loopback only
(`127.0.0.1:27018`), with the backend also local-only. This is a local
development configuration, not a remotely deployable setup. There is no
database admin web container.

## Tested versions

| Component | Tested |
| --- | --- |
| Image | `mongo:8.0.34` (pinned in `compose.yaml`) |
| Mongoose | `8.24.8` (see root `package-lock.json`, `apps/server`) |
| Node runtime | `v22.19.0` |
| Docker / Compose | `28.4.0` / `v2.39.2-desktop.1` |

Record any image upgrade here when `compose.yaml` changes.

## Layout

- Compose project `openstreetlightmapper`, service `mongodb`,
  container `openstreetlightmapper-mongodb`.
- Port `127.0.0.1:27018 → 27017` (host port 27018 avoids a default 27017).
- Database name `openstreetlightmapper`
  (`MONGODB_URI=mongodb://127.0.0.1:27018/openstreetlightmapper`).
- Named volume `openstreetlightmapper-mongo-data` mounted at `/data/db`.
  Data survives stop/start and container recreation. No normal command in
  this project deletes the volume.

## Commands (run from the repository root)

```powershell
# Start (harmless to re-run; waits for health, bounded timeout)
powershell -ExecutionPolicy Bypass -File infra\database\start.ps1

# Status (read-only)
powershell -ExecutionPolicy Bypass -File infra\database\status.ps1

# Stop (keeps the volume)
powershell -ExecutionPolicy Bypass -File infra\database\stop.ps1

# Reconnect after a stop/start: just restart the backend; it reconnects.
npm run dev --workspace @openstreetlightmapper/server
```

Then verify readiness without secrets: `GET /api/health` reports
`database: { state: "connected" }`. A present `MONGODB_URI` alone is not a
successful connection.

## Troubleshooting

- **Docker daemon not reachable / `docker info` fails.** Start Docker
  Desktop and wait until it reports running, then re-run `start.ps1`.
  On Windows the client must be able to reach the Docker engine pipe; run
  from an account in the `docker-users` group (or elevated) if access is
  denied.
- **Port 27018 already in use.** `start.ps1` refuses to touch the other
  listener. Stop whatever owns the port (or change the published port and
  `MONGODB_URI` together), then retry.
- **A different container already named `openstreetlightmapper-mongodb`.**
  `start.ps1` stops with guidance rather than touching it. Rename or remove
  that container yourself, then retry.
- **Container unhealthy.** `start.ps1` prints the last log lines. Common
  cause: the image is still pulling on first run — re-run the script.
- **Backend reports `database: unavailable`.** The app keeps already loaded
  work visible, shows **Not saved — local database unavailable**, and offers
  Retry; it never fakes a save. Start the container, wait for health, then
  use Retry (or restart the backend, which reconnects).

## Backup and restore

The image bundles the MongoDB database tools. Dump to an archive *outside*
the volume, then copy it out of the container:

```powershell
docker exec openstreetlightmapper-mongodb mongodump `
  --db openstreetlightmapper --archive=/tmp/oslm-backup.archive
docker cp openstreetlightmapper-mongodb:/tmp/oslm-backup.archive .\oslm-backup.archive
```

Restore **into a separate named database for verification**, never over the
working database:

```powershell
docker cp .\oslm-backup.archive openstreetlightmapper-mongodb:/tmp/oslm-backup.archive
docker exec openstreetlightmapper-mongodb mongorestore `
  --archive=/tmp/oslm-backup.archive `
  --nsFrom 'openstreetlightmapper.*' --nsTo 'openstreetlightmapper_verify.*'
```

Point a throwaway `MONGODB_URI` at `.../openstreetlightmapper_verify` (or
inspect with `mongosh`) to confirm the backup reads back, then drop the
verification database. Keep backup archives out of Git.

## References

- [Mongo Docker image](https://hub.docker.com/_/mongo)
- [Persistent Docker volumes](https://docs.docker.com/engine/storage/volumes/)
- [Loopback port publishing](https://docs.docker.com/engine/network/port-publishing/)
