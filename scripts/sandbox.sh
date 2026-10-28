#!/bin/sh
# Copies the test project to sandbox/ (ignored by git) for manual tests.
#   sandbox.sh          recreates the copy from test-fixtures
#   sandbox.sh --keep   creates it only when it does not exist yet
set -e
cd "$(dirname "$0")/.."
if [ "$1" = "--keep" ] && [ -d sandbox/testXliff ]; then
	exit 0
fi
rm -rf sandbox/testXliff
mkdir -p sandbox
cp -R test-fixtures/testXliff sandbox/testXliff
echo "sandbox/testXliff created from test-fixtures/testXliff"
