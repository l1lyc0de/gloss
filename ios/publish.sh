#!/bin/sh
# 出一个能传 App Store Connect 的 .ipa。对应 android/publish.sh。
#
# 和安卓那边一个明显的不同：产物**不放进 download/**。
# APK 是自己分发的，网页版要能下；iOS 只能走 App Store，
# 把 .ipa 摆到网站上没有任何人能装，只会让人以为点了能用。
#
# 另一个不同：不注入 GLOSS_UPDATE_URL。App Store 自己会提示新版本，
# App 里再放一个「检查更新」是多余的入口 —— 空着正好，
# 网页那边看到空串就整个不显示它（见 js/env.js 的 UPDATE_URL）。
set -e
cd "$(dirname "$0")"

OUT=build
ARCHIVE="$OUT/Gloss.xcarchive"

rm -rf "$ARCHIVE" "$OUT/export"
mkdir -p "$OUT"

xcodebuild archive \
  -project Gloss.xcodeproj -scheme Gloss -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath "$OUT/export" \
  -allowProvisioningUpdates

IPA="$OUT/export/Gloss.ipa"
VER=$(/usr/libexec/PlistBuddy -c "Print :ApplicationProperties:CFBundleShortVersionString" \
        "$ARCHIVE/Info.plist")
BUILD=$(/usr/libexec/PlistBuddy -c "Print :ApplicationProperties:CFBundleVersion" \
        "$ARCHIVE/Info.plist")

# 发版前自己核一遍，别等 App Store Connect 退回来才发现。
# 这几条对应安卓那边 aapt2 查权限表的位置。
#
# ⚠️ 核的必须是**解开的 .ipa**，不是 archive 里那个 .app。
# archive 阶段自动签名给的是 Apple Development + get-task-allow=true，
# 真正的分发签名是 exportArchive 重新签上去的。对着 archive 查，
# 会一边报「不是 Distribution」一边其实没问题 —— 核错了对象比不核更糟。
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
unzip -qo "$IPA" -d "$WORK"
APP="$WORK/Payload/Gloss.app"

echo
echo "→ $IPA  ($VER build $BUILD, $(du -h "$IPA" | cut -f1))"
echo
printf "签名："
if codesign -dv --verbose=2 "$APP" 2>&1 | grep -q "Authority=Apple Distribution"; then
  echo "  ✓ $(codesign -dv --verbose=2 "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
else
  echo "  ⚠️ 不是 Apple Distribution 签名，传上去会被退"
fi

ENT=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p -)
printf "调试开关："
case "$ENT" in
  *'"get-task-allow" => 0'*|*'"get-task-allow" => false'*) echo "  ✓ get-task-allow 已关" ;;
  *) echo "  ⚠️ get-task-allow 没关，这是开发包，不能上架" ;;
esac

echo
echo "权限（entitlements）—— 不该出现任何要用户授权的能力："
echo "$ENT" | sed 's/^/  /'

DICT=$(ls "$APP/public/dict" 2>/dev/null | wc -l | tr -d ' ')
printf "词典分片：%s 个" "$DICT"
[ "$DICT" = "648" ] && echo "  ✓" || echo "  ⚠️ 应为 648，资源没打全"
echo
echo "上传：xcrun altool --upload-app -f $IPA -t ios --apiKey … --apiIssuer …"
echo "或者用 Xcode 的 Organizer。"
