#!/bin/bash
# 打包 APK：aapt2 编资源 → javac 出 class → d8 转 dex → 塞回 apk → 对齐 → 签名
# 不用 gradle（那要下小半个 G 的依赖），命令行工具是确定性的，改一行重跑十几秒。
#
# 工具链（JDK17 + build-tools + android.jar）不在仓库里，太大。默认从
# ../../_apkbuild 取，换机器就设 TODO_APK_TOOLS 指过去。装工具的步骤见本目录 README。
set -e
cd "$(dirname "$0")"

TOOLS="${TODO_APK_TOOLS:-C:/Users/likaicheng/Desktop/workbuddy/_apkbuild}"
JDK="$TOOLS/jdk-17.0.21+9"
BT="$TOOLS/tools/bt/android-14"
PLAT="$TOOLS/tools/plat/android-34/android.jar"
OUT="build"
KS="todo.keystore"
PASS="todo-app-2026"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

export JAVA_HOME="$JDK"
# JDK 是 Windows 路径，往 PATH 里拼在 Git Bash 下不生效，干脆全用绝对路径调
JAVAC="$JDK/bin/javac"
JAVA="$JDK/bin/java"
KEYTOOL="$JDK/bin/keytool"

echo "[1/7] 编资源"
"$BT/aapt2.exe" compile --dir app/res -o "$OUT/res.zip"

echo "[2/7] 链接清单与资源"
"$BT/aapt2.exe" link \
  -o "$OUT/base.apk" \
  -I "$PLAT" \
  --manifest app/AndroidManifest.xml \
  --java "$OUT/gen" \
  --auto-add-overlay \
  "$OUT/res.zip"

echo "[3/7] 编译 Java"
find app/src "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# 注意不能拿 android.jar 当 -bootclasspath：它只有框架桩，没有 java.lang.invoke，
# 一用 lambda 就报找不到 LambdaMetafactory。--release 8 走 JDK 自带的 java.*，
# android.* 从 classpath 取，d8 再按 --lib 里的 android.jar 做脱糖检查。
"$JAVAC" --release 8 -nowarn -encoding UTF-8 \
  -classpath "$PLAT" \
  -d "$OUT/classes" @"$OUT/sources.txt" 2>&1 | grep -v "^Note:" || true
test -f "$OUT/classes/cn/todoreminder/app/MainActivity.class"

echo "[4/7] 转 dex"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$JAVA" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --release --min-api 24 --lib "$PLAT" \
  --output "$OUT/dex" @"$OUT/classes.txt"
ls -l "$OUT/dex/classes.dex"

echo "[5/7] 合成未签名包"
python - "$OUT/base.apk" "$OUT/dex/classes.dex" "$OUT/unsigned.apk" <<'PY'
import sys, zipfile, shutil
base, dex, out = sys.argv[1:4]
shutil.copyfile(base, out)
with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("ok")
PY

echo "[6/7] 对齐"
"$BT/zipalign.exe" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[7/7] 签名"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -keystore "$KS" -alias todo -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=Todo, OU=Home, O=Home, L=Hangzhou, ST=Zhejiang, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner.bat" sign --ks "$KS" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out todo.apk "$OUT/aligned.apk"

"$BT/apksigner.bat" verify --print-certs todo.apk | head -6
"$BT/aapt2.exe" dump badging todo.apk | head -6
ls -lh todo.apk

# 顺手放进 public/：服务器有个 /todo.apk 路由直接发这个文件，
# 传上去手机点一下就能装，不用再往网盘/微信里倒一遍。
cp todo.apk ../public/todo.apk
echo "已更新 ../public/todo.apk —— 部署时跟 server.mjs 一起传上去就行"
