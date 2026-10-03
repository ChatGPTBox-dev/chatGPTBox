#!/usr/bin/env bash

set -euo pipefail

npm run build
xcrun safari-web-extension-converter ./build/firefox \
 --project-location ./build/safari --app-name "ChatGPTBox" \
 --bundle-identifier dev.josStorer.chatGPTBox --force --no-prompt --no-open
xcodebuild archive -project "./build/safari/ChatGPTBox/ChatGPTBox.xcodeproj" \
 -scheme "ChatGPTBox (macOS)" -configuration Release -archivePath "./build/safari/ChatGPTBox.xcarchive"
xcodebuild -exportArchive -archivePath "./build/safari/ChatGPTBox.xcarchive" \
 -exportOptionsPlist ./safari/export-options.plist -exportPath ./build
rm -f ./build/safari.dmg
./node_modules/.bin/appdmg ./safari/appdmg.json ./build/safari.dmg
