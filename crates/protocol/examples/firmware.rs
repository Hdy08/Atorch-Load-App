//! Offline inspection/rehearsal; deliberately has no device transport.
use atorch_protocol::firmware::{rehearse, Image};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for argument in std::env::args().skip(1) {
        let path = std::path::Path::new(&argument);
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Invalid filename")?;
        let image = Image::inspect(name, std::fs::read(path)?)?;
        println!(
            "{} bytes={} blocks={} last={} SHA256={} AA={}",
            name,
            image.info.bytes,
            image.info.blocks,
            image.info.last_block_bytes,
            image.info.sha256,
            image.info.handshake_hex
        );
        let result = rehearse(image)?;
        println!(
            "offline={}; phase={:?}; acknowledged={}/{}",
            result.offline, result.phase, result.acknowledged_blocks, result.blocks
        );
    }
    Ok(())
}
