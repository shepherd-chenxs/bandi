/*
 * 原生壳的根构建脚本。版本组合与 gen/android（Tauri 壳）完全一致 —— 那套在本机
 * 打过包、maven 产物全在本地缓存：AGP 9.3.1 + Kotlin 2.2.10 + Gradle 9.6.1。
 * 仓库走阿里云镜像优先，官方仓库兜底（与 apps/server 的零依赖铁律精神一致：
 * 构建也要在国内网络下可复现）。
 */
buildscript {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
