#!/usr/bin/env node
/**
 * build-android.mjs —— 手机壳的 Android 构建入口（2026-11）。
 *
 * 为什么不用 `cargo tauri android build`：Tauri CLI 在 Windows 上要把编译出的
 * `.so` **符号链接**进 `gen/android/app/src/main/jniLibs/`，普通用户没有
 * `SeCreateSymbolicLinkPrivilege`，除非开 Windows 开发者模式，否则必然失败
 * （`cargo-mobile2/src/android/jnilibs.rs` 的 `force_symlink` 没有回退）。
 *
 * 所以这里把那条路拆开，每一步都显式做：
 *   ① cargo build（NDK clang 当 linker，features 带 tauri/custom-protocol，
 *      前端就是在这步被 codegen 嵌进 .so 的）；
 *   ② 复制 .so 到 jniLibs/<abi>/（不是链接）；
 *   ③ 补 assets/tauri.conf.json —— `PluginManager.kt:231` 运行时要读它，缺了直接崩；
 *   ④ 补 local.properties（sdk.dir）；
 *   ⑤ 直接跑 gradlew（app/build.gradle.kts 已摘掉 id("rust")，不会再回头调 cargo）。
 *
 * 用法：
 *   node apps/mobile/build-android.mjs                 # debug / arm64
 *   node apps/mobile/build-android.mjs --release       # release（未签名 APK）
 *   node apps/mobile/build-android.mjs --abi x86_64    # 模拟器
 *   node apps/mobile/build-android.mjs --skip-cargo    # 复用已有 .so，只重新打包
 *
 * 环境变量：ANDROID_HOME（默认 E:\Android\Sdk）、NDK_HOME（默认取 ndk/ 下最新）、JAVA_HOME。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, 'gen', 'android');
const PROJECT = path.join(APP_DIR, 'app');

/* ---------------------------------------------------------------- 参数 */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const profile = has('--release') ? 'release' : 'debug';
const abi = opt('--abi', 'arm64');
const skipCargo = has('--skip-cargo');

const TARGETS = {
  arm64: { triple: 'aarch64-linux-android', clang: 'aarch64-linux-android', dir: 'arm64-v8a' },
  armv7: { triple: 'armv7-linux-androideabi', clang: 'armv7a-linux-androideabi', dir: 'armeabi-v7a' },
  x86: { triple: 'i686-linux-android', clang: 'i686-linux-android', dir: 'x86' },
  x86_64: { triple: 'x86_64-linux-android', clang: 'x86_64-linux-android', dir: 'x86_64' },
};

const target = TARGETS[abi];
if (!target) {
  console.error(`未知 ABI：${abi}（可选：${Object.keys(TARGETS).join(' / ')}）`);
  process.exit(1);
}

/* ---------------------------------------------------------------- 环境 */

const ANDROID_HOME =
  process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'E:\\Android\\Sdk';

function newestNdk(sdk) {
  const base = path.join(sdk, 'ndk');
  if (!fs.existsSync(base)) return '';
  const dirs = fs
    .readdirSync(base)
    .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : '';
}

const NDK_HOME = process.env.NDK_HOME || newestNdk(ANDROID_HOME);
const JAVA_HOME = process.env.JAVA_HOME || '';

if (!fs.existsSync(ANDROID_HOME)) {
  console.error(`找不到 Android SDK：${ANDROID_HOME}（设 ANDROID_HOME）`);
  process.exit(1);
}
if (!NDK_HOME || !fs.existsSync(NDK_HOME)) {
  console.error(`找不到 NDK（设 NDK_HOME，或装在 ${ANDROID_HOME}\\ndk 下）`);
  process.exit(1);
}

const HOST_TAG =
  process.platform === 'win32'
    ? 'windows-x86_64'
    : process.platform === 'darwin'
      ? 'darwin-x86_64'
      : 'linux-x86_64';
const EXE = process.platform === 'win32' ? '.cmd' : '';
const TOOLCHAIN = path.join(NDK_HOME, 'toolchains', 'llvm', 'prebuilt', HOST_TAG, 'bin');
// minSdk 与 gen/android/app/build.gradle.kts 的 24 对齐
const CLANG = path.join(TOOLCHAIN, `${target.clang}24-clang${EXE}`);

const env = { ...process.env, ANDROID_HOME, NDK_HOME };
if (JAVA_HOME) env.JAVA_HOME = JAVA_HOME;
const tripleVar = target.triple.replace(/-/g, '_').toUpperCase();
env[`CARGO_TARGET_${tripleVar}_LINKER`] = CLANG;
env[`CC_${target.triple.replace(/-/g, '_')}`] = CLANG;
env[`AR_${target.triple.replace(/-/g, '_')}`] = path.join(
  TOOLCHAIN,
  process.platform === 'win32' ? 'llvm-ar.exe' : 'llvm-ar',
);

/* ------------------------------------------------- tauri/wry 的 Kotlin codegen */
/*
 * `TauriActivity.kt` / `WryActivity.kt` / `RustWebView.kt` 这些 Kotlin 文件不是入源码的，
 * 是 **cargo 编译 tauri 和 wry 时由它俩的 build.rs 生成** 到
 * `app/src/main/java/<包名>/generated/`。生成的前提是下面这几个环境变量存在 ——
 * tauri CLI 会自动设，我们绕过 CLI 就必须自己设，否则 app 模块编译直接挂在
 * "Unresolved reference 'TauriActivity'"。
 *
 * ⚠️ tauri 的 build.rs **没有** 声明 `rerun-if-env-changed`（wry 有），
 * 所以如果曾经在没设变量的情况下编过一次，必须先
 * `cargo clean -p tauri --target <triple>`，否则这个 crate 的 build script 不会再跑。
 */
const tauriConf = JSON.parse(fs.readFileSync(path.join(HERE, 'tauri.conf.json'), 'utf8'));
const ANDROID_PKG = tauriConf.identifier; // 与 app/build.gradle.kts 的 namespace 一致
const cargoToml = fs.readFileSync(path.join(HERE, 'Cargo.toml'), 'utf8');
const libSection = (cargoToml.match(/\[lib\]([\s\S]*?)(?=\n\[|$)/) || [])[1] || '';
const LIB_NAME = (libSection.match(/name\s*=\s*"([^"]+)"/) || [])[1] || 'bandi_mobile';
const KOTLIN_GEN_DIR = path.join(PROJECT, 'src', 'main', 'java', ...ANDROID_PKG.split('.'), 'generated');
fs.mkdirSync(KOTLIN_GEN_DIR, { recursive: true });
env.WRY_ANDROID_PACKAGE = ANDROID_PKG;
env.TAURI_ANDROID_PACKAGE_UNESCAPED = ANDROID_PKG;
env.WRY_ANDROID_LIBRARY = LIB_NAME;
env.TAURI_ANDROID_PROJECT_PATH = APP_DIR;
env.WRY_ANDROID_KOTLIN_FILES_OUT_DIR = KOTLIN_GEN_DIR;

/* app/build.gradle.kts 末尾会 `apply(from = file("tauri.build.gradle.kts"))`，
   这个文件由 CLI 生成、被 gitignore；缺失时 gradle 直接报 "Could not read script"。
   本项目没有带 Android 代码的 tauri 插件，所以留个空壳就行。 */
const tauriBuildGradle = path.join(PROJECT, 'tauri.build.gradle.kts');
if (!fs.existsSync(tauriBuildGradle)) {
  fs.writeFileSync(
    tauriBuildGradle,
    [
      '// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
      '// 由 tauri CLI 生成（本工程由 build-android.mjs 兜底生成）：挂带 Android 代码的',
      '// tauri 插件工程用。班底没有这类插件，所以为空。',
      '',
    ].join('\n'),
  );
}

const log = (msg) => console.log(`\n▸ ${msg}`);
const die = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    env,
    ...opts,
  });
  if (r.error) die(`${cmd} 起不来：${r.error.message}`);
  if (r.status !== 0) die(`${cmd} 退出码 ${r.status}`);
}

/* ---------------------------------------------------------------- ① cargo */

const soName = 'libbandi_mobile.so';
const soPath = path.join(
  HERE,
  'target',
  target.triple,
  profile,
  soName,
);

if (skipCargo) {
  log('跳过 cargo（--skip-cargo），直接复用已有 .so');
  if (!fs.existsSync(soPath)) die(`没有现成的 .so：${soPath}（去掉 --skip-cargo 重跑）`);
} else {
  log(`编译 Rust（${target.triple} / ${profile}）`);
  const cargoArgs = [
    'build',
    '--package',
    'bandi-mobile',
    '--manifest-path',
    path.join(HERE, 'Cargo.toml'),
    '--target',
    target.triple,
    '--lib',
    // 前端资源由 tauri-codegen 嵌进 .so，靠的就是这个 feature
    '--features',
    'tauri/custom-protocol',
  ];
  if (profile === 'release') cargoArgs.push('--release');
  run('cargo', cargoArgs);

  // 生成物是 app 编译的硬前提，缺了报错要能一眼看懂
  if (!fs.existsSync(path.join(KOTLIN_GEN_DIR, 'TauriActivity.kt'))) {
    die(
      `cargo 跑完了但没有生成 ${KOTLIN_GEN_DIR}/TauriActivity.kt。\n` +
        '  多半是 tauri crate 的 build script 之前没带 WRY_ANDROID_* 变量跑过（它没声明\n' +
        '  rerun-if-env-changed）。清一次就好：\n' +
        `    cargo clean -p tauri --target ${target.triple}`,
    );
  }
}

/* ---------------------------------------------------------------- ② .so */

log(`复制 .so → jniLibs/${target.dir}/`);
const jniRoot = path.join(PROJECT, 'src', 'main', 'jniLibs');
// 先清掉其它 ABI 的旧 .so：不清的话上一次编的架构会一起打进 APK（体积直接翻倍）
if (fs.existsSync(jniRoot)) {
  for (const d of fs.readdirSync(jniRoot)) {
    if (d !== target.dir) fs.rmSync(path.join(jniRoot, d), { recursive: true, force: true });
  }
}
const jniDir = path.join(jniRoot, target.dir);
fs.mkdirSync(jniDir, { recursive: true });
fs.copyFileSync(soPath, path.join(jniDir, soName));

/* ---------------------------------------------------------------- ③ assets */

log('补 assets/tauri.conf.json');
const assetsDir = path.join(PROJECT, 'src', 'main', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.copyFileSync(path.join(HERE, 'tauri.conf.json'), path.join(assetsDir, 'tauri.conf.json'));

/* ---------------------------------------------------------------- ③.5 manifest 手改项 */

/*
 * `gen/android` 是 `tauri android init` 生成的，但**我们手改过**几处（相机 / 录音权限、
 * SpeechRecognizer 的包可见性、锁竖屏）。一旦有人重新 init，这些改动会静默消失，
 * 表现分别是"相机权限被拒绝""这台手机没有语音引擎""横屏能转" —— 每一条都要实机排半天。
 *
 * 打包前扫一遍：缺了就**吼出来**，但不拦构建（缺的是功能，不是编译错误）。
 */
log('检查 AndroidManifest 的手改项');
const manifestPath = path.join(PROJECT, 'src', 'main', 'AndroidManifest.xml');
const MANUAL_MANIFEST_BITS = [
  ['android.permission.CAMERA', '扫一扫 → 相机权限'],
  ['android.permission.RECORD_AUDIO', '语音输入 → 录音权限'],
  ['android.speech.RecognitionService', '语音输入 → SpeechRecognizer 包可见性'],
  ['android:screenOrientation="portrait"', '手机端锁竖屏'],
];
const manifestText = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
if (!manifestText) {
  console.warn('  ! 找不到 AndroidManifest.xml（tauri android init 还没跑过？）');
} else {
  for (const [needle, label] of MANUAL_MANIFEST_BITS) {
    if (!manifestText.includes(needle)) console.warn(`  ! manifest 缺手改项：${label}（重新 init 后要补回来）`);
  }
}

/* ---------------------------------------------------------------- ④ local.properties */

log('补 local.properties');
fs.writeFileSync(
  path.join(APP_DIR, 'local.properties'),
  `sdk.dir=${ANDROID_HOME.replace(/\\/g, '\\\\')}\n`,
);

/* ---------------------------------------------------------------- ④.1 tauri.properties */

/*
 * `app/build.gradle.kts` 从这里读 versionName / versionCode。Tauri CLI 每次构建会重写，
 * 但我们不走 CLI —— 自己从**版本真源** `apps/desktop/version.json` 生成，
 * 否则改了真源而这里还是旧值，APK 的 versionName 会悄悄漂。
 * versionCode 算法与 tauri-cli 一致：major*1000000 + minor*1000 + patch。
 */
log('生成 tauri.properties');
const versionFile = path.join(HERE, '..', 'desktop', 'version.json');
const appVersion = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
const [vMajor, vMinor, vPatch] = String(appVersion).split('.').map(Number);
fs.writeFileSync(
  path.join(PROJECT, 'tauri.properties'),
  [
    '// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
    `tauri.android.versionName=${appVersion}`,
    `tauri.android.versionCode=${vMajor * 1000000 + vMinor * 1000 + (vPatch || 0)}`,
    '',
  ].join('\n'),
);

/* ---------------------------------------------------------------- ④.5 tauri-android 模块 */

/*
 * `tauri.settings.gradle` 里是**绝对路径**指向本机 cargo registry 里的
 * tauri-<version>/mobile/android。tauri CLI 每次构建都会重写它，但我们不走 CLI，
 * 所以要自己写：换机器、升级 tauri 版本后，旧路径直接失效。
 */
log('重写 tauri.settings.gradle');
function tauriAndroidDir() {
  const r = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--manifest-path', path.join(HERE, 'Cargo.toml')],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const meta = JSON.parse(r.stdout);
    const tauri = meta.packages.find((p) => p.name === 'tauri');
    if (!tauri) return null;
    return path.join(path.dirname(tauri.manifest_path), 'mobile', 'android');
  } catch {
    return null;
  }
}
const tauriAndroid = tauriAndroidDir();
if (tauriAndroid && fs.existsSync(tauriAndroid)) {
  // Groovy 字符串里用正斜杠，免得反斜杠转义踩坑
  fs.writeFileSync(
    path.join(APP_DIR, 'tauri.settings.gradle'),
    [
      '// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
      "include ':tauri-android'",
      `project(':tauri-android').projectDir = new File("${tauriAndroid.replace(/\\/g, '/')}")`,
      '',
    ].join('\n'),
  );
} else {
  console.warn('  ! 找不到 tauri 的 mobile/android 目录，沿用现有 tauri.settings.gradle');
}

/* ---------------------------------------------------------------- ⑤ gradle */

const task = profile === 'release' ? 'assembleRelease' : 'assembleDebug';
log(`Gradle ${task}`);
// Node 18+ 不允许直接 spawn .bat（EINVAL），Windows 上必须过一层 cmd /c
if (process.platform === 'win32') {
  run('cmd', ['/c', 'gradlew.bat', task, '--console=plain'], { cwd: APP_DIR });
} else {
  run('./gradlew', [task, '--console=plain'], { cwd: APP_DIR });
}

/* ---------------------------------------------------------------- 产物 */

const apkRoot = path.join(PROJECT, 'build', 'outputs', 'apk');
const found = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.apk')) found.push(p);
  }
})(apkRoot);

if (!found.length) die('Gradle 跑完了但没找到 APK');
log('完成');
for (const p of found) {
  const mb = (fs.statSync(p).size / 1024 / 1024).toFixed(1);
  console.log(`  ${p}  (${mb} MB)`);
}
