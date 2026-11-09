#!/bin/sh
# Creates the application role, once, on first boot of an empty data directory.
#
# It has to be an ordinary role. `force row level security` forces policies on the table *owner* and
# does not touch a superuser: a superuser bypasses every policy silently, so an application
# connecting as one gets a database that has stopped enforcing tenancy without saying so, and the
# tenancy tests still pass.
#
# `createdb` is not granted: nothing in production creates databases. The integration suite does,
# which is why CI grants it there and this does not.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
  create role product_renderer login password '${POSTGRES_APP_PASSWORD}';
  alter database product_renderer owner to product_renderer;
SQL
