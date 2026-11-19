#![windows_subsystem = "windows"]

fn main() {
    let ctx = match rgl::cli::Context::from_env() {
        Ok(ctx) => ctx,
        Err(_) => return,
    };
    if let Err(e) = rgl::daemon::run(ctx) {
        rgl::log::write(&format!("daemon stopped: {e:#}"));
    }
}
