plugins { id("com.android.application") }
android {
    namespace = "org.wakebridge.agent"
    compileSdk = 37
    defaultConfig { applicationId = "org.wakebridge.agent"; minSdk = 26; targetSdk = 37; versionCode = 2; versionName = "0.2.0" }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    signingConfigs {
        create("externalRelease") {
            val path = System.getenv("WAKEBRIDGE_KEYSTORE")
            if (!path.isNullOrEmpty()) { storeFile = file(path); storePassword = System.getenv("WAKEBRIDGE_STORE_PASSWORD"); keyAlias = System.getenv("WAKEBRIDGE_KEY_ALIAS"); keyPassword = System.getenv("WAKEBRIDGE_KEY_PASSWORD") }
        }
    }
    buildTypes {
        release { isMinifyEnabled = true; isShrinkResources = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"); if (!System.getenv("WAKEBRIDGE_KEYSTORE").isNullOrEmpty()) signingConfig = signingConfigs.getByName("externalRelease") }
    }
    lint { abortOnError = true }
}
dependencies {
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("com.google.android.material:material:1.14.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    testImplementation("junit:junit:4.13.2")
}
