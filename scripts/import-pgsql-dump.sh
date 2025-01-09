#!/usr/bin/env bash

set -e

if [[ $# -ne 1 ]]; then
  echo "Usage : $0 chemin/vers/mon/fichier.sql"
  exit 1
fi

SQL_FILE=$1
DB_NAME=$POSTGRES_DB
PG_USER=$POSTGRES_USER

if [[ ! -f "$SQL_FILE" ]]; then
  echo "Erreur : Le fichier '$SQL_FILE' n'existe pas."
  exit 1
fi

if psql -U "$PG_USER" -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
  echo "La base $DB_NAME existe déjà."
else
  echo "La base $DB_NAME n'existe pas, création..."
  createdb -U "$PG_USER" "$DB_NAME"
  echo "Base $DB_NAME créée avec succès."
fi

echo "Importation du fichier SQL dans la base $DB_NAME..."
pg_restore -U "$PG_USER" -d "$DB_NAME" "$SQL_FILE"

echo "Importation terminée avec succès."
