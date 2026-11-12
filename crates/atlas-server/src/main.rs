use anyhow::{bail, Context, Result};
use atlas_core::Store;
use atlas_server::{start, ServerOptions};
use rand::RngCore;
use std::{
    io::{Read, Write},
    path::PathBuf,
};
#[tokio::main]
async fn main() -> Result<()> {
    let mut db = PathBuf::from("atlas.sqlite");
    let mut token_file = PathBuf::from("atlas.token");
    let mut port = 38473;
    let mut origins = vec![];
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = args.next().context("--db needs path")?.into(),
            "--port" => port = args.next().context("--port needs number")?.parse()?,
            "--token-file" => token_file = args.next().context("--token-file needs path")?.into(),
            "--allow-origin" => origins.push(args.next().context("--allow-origin needs origin")?),
            "--help" | "-h" => {
                println!(
                    "atlas-server --db PATH --port PORT --token-file PATH --allow-origin ORIGIN"
                );
                return Ok(());
            }
            _ => bail!("unknown argument {arg}"),
        }
    }
    if let Some(p) = db.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(p)?;
    }
    let token = load_token(&token_file)?;
    let first_run = !db.exists();
    let store = Store::open(&db)?;
    if first_run {
        store.seed_demo()?;
    }
    let server = start(
        store,
        ServerOptions {
            port,
            token,
            allowed_origins: origins,
        },
    )
    .await?;
    println!(
        "http://127.0.0.1:{}\ntoken-file: {}",
        server.port,
        token_file.display()
    );
    tokio::signal::ctrl_c().await?;
    server.shutdown();
    Ok(())
}
fn load_token(path: &std::path::Path) -> Result<String> {
    if let Some(p) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(p)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut f) => {
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
            f.write_all(token.as_bytes())?;
            f.sync_all()?;
            Ok(token)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let meta = std::fs::symlink_metadata(path)?;
                if !meta.is_file() || meta.permissions().mode() & 0o077 != 0 {
                    bail!("token-file must be a private regular file (chmod 600)");
                }
            }
            let mut token = String::new();
            std::fs::File::open(path)?.read_to_string(&mut token)?;
            Ok(token.trim().into())
        }
        Err(e) => Err(e.into()),
    }
}
