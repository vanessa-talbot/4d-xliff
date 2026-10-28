#!/bin/sh
# Runs src/test/integration in the installed VS Code, on a temporary copy of the test project.
set -e
cd "$(dirname "$0")/.."
CODE="${VSCODE_BIN:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R test-fixtures/testXliff "$WORK/testXliff"
rm -rf "$WORK/testXliff/Data" "$WORK/testXliff/userPreferences."*
npm run compile --silent
env -u ELECTRON_RUN_AS_NODE "$CODE" --user-data-dir "$WORK/user" --extensions-dir "$WORK/extensions" --disable-extensions \
	--disable-workspace-trust --skip-welcome --skip-release-notes \
	--extensionDevelopmentPath="$PWD" --extensionTestsPath="$PWD/out/test/integration/index.js" \
	"$WORK/testXliff"
