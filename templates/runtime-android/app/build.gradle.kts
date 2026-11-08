// SPDX-License-Identifier: GPL-3.0-or-later
//
// Application id, name and permissions are injected by the compiler through
// -P parameters, so this template never needs to be edited by hand.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val appId: String = (project.findProperty("appId") as String?) ?: "org.easyapp.app"
val appName: String = (project.findProperty("appName") as String?) ?: "EasyApp"
val appVersion: String = (project.findProperty("appVersion") as String?) ?: "1.0.0"
val appVersionCode: Int = ((project.findProperty("appVersionCode") as String?) ?: "1").toInt()
val allowInternet: Boolean = ((project.findProperty("allowInternet") as String?) ?: "false").toBoolean()
val allowFiles: Boolean = ((project.findProperty("allowFiles") as String?) ?: "false").toBoolean()
val orientation: String = (project.findProperty("orientation") as String?) ?: "unspecified"

android {
    namespace = "org.easyapp.runtime"
    compileSdk = 34

    defaultConfig {
        applicationId = appId
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersion
        // Escape XML specials: resValue writes into a generated values.xml,
        // so a name containing & or < would otherwise break the build.
        resValue("string", "app_name", appName
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "\\'"))
        manifestPlaceholders["orientation"] = orientation
        buildConfigField("boolean", "ALLOW_INTERNET", allowInternet.toString())
        buildConfigField("boolean", "ALLOW_FILES", allowFiles.toString())
    }

    buildFeatures { buildConfig = true }

    // The debug key is used for local builds; release signing is configured
    // through -P properties or the CI keystore, never committed to the repo.
    signingConfigs {
        create("compilerRelease") {
            val ksPath = project.findProperty("signingStoreFile") as String?
            if (ksPath != null && file(ksPath).exists()) {
                storeFile = file(ksPath)
                storePassword = project.findProperty("signingStorePassword") as String?
                keyAlias = project.findProperty("signingKeyAlias") as String?
                keyPassword = project.findProperty("signingKeyPassword") as String?
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            val ksPath = project.findProperty("signingStoreFile") as String?
            signingConfig = if (ksPath != null && file(ksPath).exists())
                signingConfigs.getByName("compilerRelease")
            else signingConfigs.getByName("debug")
        }
        debug { }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Only the permissions that were actually requested end up in the APK.
    // "files" needs no manifest permission (Storage Access Framework), so the
    // sole variable is INTERNET. allowFiles is enforced by the bridge instead.
    sourceSets {
        getByName("main") {
            manifest.srcFile(
                if (allowInternet) "src/main/AndroidManifest.internet.xml"
                else "src/main/AndroidManifest.xml"
            )
        }
    }
}

dependencies {
    // No third-party runtime dependencies: the host uses only the platform SDK,
    // which keeps the F-Droid build reproducible and the APK small.
    implementation(kotlin("stdlib"))
}
