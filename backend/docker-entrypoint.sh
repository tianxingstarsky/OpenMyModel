#!/bin/sh
set -e
cd /app
# Configuration initialization and password hashing belong to the application.
exec node dist/index.js
