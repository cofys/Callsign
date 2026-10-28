plugins {
    id("com.android.application") version "8.5.0"
    kotlin("android") version "1.9.24"
}

android {
    namespace = "dev.callsign.companion"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.callsign.companion"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    // Pure Kotlin/DEX bytecode with zero native C++ (.so) dependencies:
    // Produces a tiny (~90 KB) Universal APK that runs on all ARM64, ARMv7, and x86_64 phones.
    buildTypes {
        release {
            isMinifyEnabled = true
            // Sign with standard debug key out-of-the-box so `gradlew assembleRelease`
            // produces an immediately installable universal APK without keystore setup.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    sourceSets {
        getByName("main") {
            manifest.srcFile("AndroidManifest.xml")
            java.srcDirs(".")
            assets.srcDirs("assets")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
