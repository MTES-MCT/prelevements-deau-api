# API delivery checks

Quality and candidate-image validation run concurrently. Deployment requires both
to succeed for the same Git SHA and immutable image digest. The existing private
migration, API, worker and health checks retain their order. Environment aliases
are published only afterwards.

Each AVA shard has its own PostgreSQL/PostGIS and Redis services. Native AVA
partitioning uses zero-based `CI_NODE_INDEX` (0/1), `CI_NODE_TOTAL=2` and
`--concurrency=1`. Both shards migrate an empty database, replay the migrations
and run the same integration flags. Lint and OpenAPI checks run on shard 0.

The static **API quality, migrations and integration tests** check requires every
quality job to succeed. It verifies the exact files actually completed by AVA
against the full discovered inventory, with no gaps or overlaps, and checks the
commit, dependency lock, partition and checkout path before merging raw V8
coverage once with c8. Before upload, raw V8 records discard only the modules c8
already excludes, using c8's own configured file filter; retained function ranges
and their source maps are unchanged. This avoids transferring dependency coverage.
The observer/discovery and compaction contracts are checked against the
locked AVA version; upgrades must revalidate it. An absent shard, failed worker,
stale revision or empty/missing coverage makes this check fail.

Shard artifact names are stable within a workflow run and overwritten only when
that shard is rerun. **Re-run failed jobs** can therefore reuse a successful shard
of the same commit while replacing a failed shard. Missing/expired artifacts
require **Re-run all jobs**. Artifacts from another run are never downloaded.

BuildKit caches use `buildcache-api-{testing,demo,prod}` tags in the existing API
image repository. The namespace and image visibility are verified through the
Scaleway API before pushing. These caches include private submodule content and
must remain in the private registry: never replace them with a GitHub Actions
cache, image tar artifact, or Buildx build-record upload. Audit reports contain
image vulnerability metadata, not private image layers. The initial cache is
cold; warm-build savings depend on which Dockerfile layers changed.

The image and deployment runners do not install host application dependencies.
The Dockerfile still uses locked npm dependencies, generates Prisma, prunes dev
dependencies and pins Node. Image scan, native-module smoke test, size and
certificate checks remain mandatory. Separate environment images retain their
own certificates and migration services.

Local workflow checks (no deployment):

```sh
node --test .github/scripts/ci-guards.test.mjs
bash .github/scripts/check-workflows.sh
```

With the isolated services and test environment from `quality.yml` (use local
Redis port 56391, as required by the disposable-service guard), run each shard
against a freshly migrated disposable database, then merge from the same checkout:

```sh
CI_NODE_INDEX=0 CI_NODE_TOTAL=2 node .github/scripts/ci-shards.mjs run
# Recreate only the dedicated disposable database before shard 1.
CI_NODE_INDEX=1 CI_NODE_TOTAL=2 node .github/scripts/ci-shards.mjs run
node .github/scripts/ci-shards.mjs merge
```

Fresh local execution requires removing its previous `coverage/shard-*` and
`coverage/merged-v8` outputs first; the runner refuses to reuse stale coverage.
