use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    let cli = rgl::cli::Cli::parse();
    match rgl::cli::run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
