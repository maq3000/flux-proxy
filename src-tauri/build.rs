fn main() {
    tauri_build::build();

    if cfg!(target_os = "windows") {
        if let Some(out_dir) = std::env::var_os("OUT_DIR") {
            println!(
                "cargo:rustc-link-search=native={}",
                std::path::Path::new(&out_dir).display()
            );
        }
    }
}
