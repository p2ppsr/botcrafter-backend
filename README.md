# Botcrafter backend


## Node security maintenance (2026-10-22)

The historical automatic Cloud Run deployment workflow is retired. Re-enabling
deployment requires a documented current owner and a separately validated
release procedure. The retained build uses Node.js22.23.4, a frozen dependency
lock and the local Knex executable. Application protocols, migrations and
dependency versions are unchanged. CI qualifies the Linux image without cloud
credentials, service creation or database writes.
