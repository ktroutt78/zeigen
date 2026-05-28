use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let engine_dir = manifest_dir.join("recording-engine");
    let scratch_path = manifest_dir.join("target/recording-engine-build");

    // Build the Swift engine release-optimized so the bundled sidecar is not debug.
    let status = Command::new("swift")
        .arg("build")
        .arg("-c")
        .arg("release")
        .arg("--scratch-path")
        .arg(&scratch_path)
        .current_dir(&engine_dir)
        .status()
        .expect("swift build: failed to invoke swift");
    assert!(status.success(), "swift build failed for recording-engine");

    // Stage the engine as a Tauri sidecar (externalBin): the bundler expects
    // binaries/recording-engine-<target-triple> and copies it into the app at
    // Contents/MacOS/recording-engine, making the packaged app standalone.
    // Must run before tauri_build::build(), which validates externalBin exists.
    let target = std::env::var("TARGET").expect("TARGET");
    let built = scratch_path.join("release/recording-engine");
    let binaries_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&binaries_dir).expect("create binaries dir");
    std::fs::copy(&built, binaries_dir.join(format!("recording-engine-{target}")))
        .expect("stage engine sidecar");

    tauri_build::build();

    println!("cargo:rerun-if-changed=recording-engine/Sources");
    println!("cargo:rerun-if-changed=recording-engine/Package.swift");
}
