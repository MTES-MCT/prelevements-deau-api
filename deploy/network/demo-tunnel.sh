#!/bin/sh
# PostgreSQL and proxy access only. No database/Scaleway credential is passed to SSH.
set -eu

exec ssh \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=15 \
  -N \
  -L 127.0.0.1:17063:172.16.12.2:5432 \
  -L 127.0.0.1:13128:127.0.0.1:3128 \
  -J bastion@51.158.122.78:61000 \
  pe-admin@172.16.12.19
