plugins {
    kotlin("jvm") version "2.1.20"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(kotlin("stdlib"))
    implementation("org.apache.kafka:kafka-streams:3.9.1")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.18.3")
    implementation("org.postgresql:postgresql:42.7.5")
    implementation("org.slf4j:slf4j-simple:2.0.17")

    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("dev.minishop.seckill.MainKt")
}

tasks.test {
    useJUnitPlatform()
}
