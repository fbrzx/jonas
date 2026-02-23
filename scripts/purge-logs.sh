#!/bin/bash
# Purge all logs from the SQLite database

DB_PATH="${DB_PATH:-../.volumes/agent-data/conversations.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found: $DB_PATH"
  exit 1
fi

sqlite3 "$DB_PATH" "DELETE FROM logs; VACUUM;"
echo "All logs purged from $DB_PATH."
