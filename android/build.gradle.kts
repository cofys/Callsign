plugins {
    id("com.android.application") version "8.5.0"
    kotlin("android") version "1.9.24"
}

// Kotlin sources live in src/ (see sourceSets below). They cannot sit in the
// project root next to the .kts build scripts: a root-level source dir makes
// the Kotlin compiler try to compile build.gradle.kts / settings.gradle.kts
// as scripts (internal error: NoDescriptorForDeclarationException SCRIPT),
// and makes compile tasks treat Gradle's own build/ outputs as inputs
// (implicit-dependency task-validation failures).

android {
    namespace = "dev.callsign.companion"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.callsign.companion"
        minSdk = 24
        targetSdk = 34
        versionCode = 4
        versionName = "1.2.1"
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
            java.srcDirs("src")
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
