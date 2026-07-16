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

    // Build the V3 Core Image compositor (single-file swiftc, release-optimized)
    // and stage it as a second Tauri sidecar, so the packaged app carries its own
    // cicompositor at Contents/MacOS/cicompositor. Same must-run-before-tauri_build
    // ordering as the engine (externalBin existence is validated there).
    let compositor_src = manifest_dir.join("compositor-engine/main.swift");
    let compositor_out = scratch_path.join("cicompositor");
    let status = Command::new("swiftc")
        .arg("-O")
        .arg(&compositor_src)
        .arg("-o")
        .arg(&compositor_out)
        .status()
        .expect("swiftc: failed to invoke for compositor-engine");
    assert!(status.success(), "swiftc failed for compositor-engine");
    std::fs::copy(&compositor_out, binaries_dir.join(format!("cicompositor-{target}")))
        .expect("stage compositor sidecar");

    tauri_build::build();

    println!("cargo:rerun-if-changed=recording-engine/Sources");
    println!("cargo:rerun-if-changed=recording-engine/Package.swift");
    println!("cargo:rerun-if-changed=recording-engine/Info.plist");
    println!("cargo:rerun-if-changed=compositor-engine/main.swift");
}
