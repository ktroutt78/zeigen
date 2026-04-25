use std::process::Command;

fn main() {
    tauri_build::build();

    let engine_dir = std::env::current_dir()
        .expect("current_dir")
        .join("recording-engine");
    let scratch_path = std::env::current_dir()
        .expect("current_dir")
        .join("target/recording-engine-build");
    let status = Command::new("swift")
        .arg("build")
        .arg("--scratch-path")
        .arg(&scratch_path)
        .current_dir(&engine_dir)
        .status()
        .expect("swift build: failed to invoke swift");
    assert!(status.success(), "swift build failed for recording-engine");

    println!("cargo:rerun-if-changed=recording-engine/Sources");
    println!("cargo:rerun-if-changed=recording-engine/Package.swift");
}
