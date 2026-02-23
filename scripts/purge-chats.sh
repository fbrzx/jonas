#!/bin/bash
# Purge all chats from the SQLite database

DB_PATH="${DB_PATH:-../.volumes/agent-data/conversations.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found: $DB_PATH"
  exit 1
fi

sqlite3 "$DB_PATH" "DELETE FROM chats; VACUUM;"
echo "All chats purged from $DB_PATH."
