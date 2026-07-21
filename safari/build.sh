#!/usr/bin/env bash

set -euo pipefail

npm run build
git apply safari/project.pre.patch
xcrun safari-web-extension-converter ./build/firefox \
 --project-location ./build/safari --app-name "Fission - ChatBox" \
 --bundle-identifier dev.josStorer.chatGPTBox --force --no-prompt --no-open
xcodebuild archive -project "./build/safari/Fission - ChatBox/Fission - ChatBox.xcodeproj" \
 -scheme "Fission - ChatBox (macOS)" -configuration Release -archivePath "./build/safari/Fission - ChatBox.xcarchive"
xcodebuild -exportArchive -archivePath "./build/safari/Fission - ChatBox.xcarchive" \
 -exportOptionsPlist ./safari/export-options.plist -exportPath ./build
rm -f ./build/safari.dmg
./node_modules/.bin/appdmg ./safari/appdmg.json ./build/safari.dmg
