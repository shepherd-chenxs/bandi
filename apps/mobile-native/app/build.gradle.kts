import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 版本真源沿用全仓唯一一份：apps/desktop/version.json（窗口标题/安装包/本 App 三处同源）。
// versionCode 方案照搬 Tauri 壳的 tauri.properties：major*1e6 + minor*1e3 + patch，
// 1.5.19 = 1005019 > 旧壳的 1005000，覆盖安装走升级。
val appVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(file("../../desktop/version.json").readText())?.groupValues?.get(1) ?: "0.0.0"
val versionParts = appVersion.split(".").map { it.toInt() }
val appVersionCode = versionParts[0] * 1_000_000 + versionParts[1] * 1_000 + versionParts[2]

android {
    compileSdk = 37
    namespace = "app.local.bandi.mobile"
    defaultConfig {
        // 局域网产品：面板是 http://192.168.x.x，明文必须放行（与 Tauri 壳同口径）。
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "app.local.bandi.mobile"
        minSdk = 24
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersion
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        viewBinding = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
}
