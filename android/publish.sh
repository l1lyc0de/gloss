#!/bin/sh
# 构建 release 包，放到 download/ 让网页版能下。
#
# APK 不进 public/：那个目录会被整个打进 APK 的 assets，
# 放进去等于安装包里再装一份自己。
set -e
cd "$(dirname "$0")"

./gradlew assembleRelease

APK=app/build/outputs/apk/release/app-release.apk
OUT=../download
VER=$(sed -n 's/.*versionName "\(.*\)".*/\1/p' app/build.gradle)

mkdir -p "$OUT"
cp "$APK" "$OUT/gloss.apk"
cat > "$OUT/gloss.json" <<JSON
{
  "version": "$VER",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sha256": "$(shasum -a 256 "$APK" | cut -d' ' -f1)",
  "bytes": $(wc -c < "$APK" | tr -d ' ')
}
JSON

echo "→ $OUT/gloss.apk  ($VER, $(du -h "$OUT/gloss.apk" | cut -f1))"
