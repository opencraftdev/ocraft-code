#!/bin/sh
# Builds "OCraft Voice.app" into ~/Applications (or $1).
set -e
here=$(cd "$(dirname "$0")" && pwd)
app="${1:-$HOME/Applications}/OCraft Voice.app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
swiftc -O "$here/main.swift" -o "$app/Contents/MacOS/OCraftVoice"
codesign --force --sign - "$app"
echo "$app"
