//! Replay a passive official capture or the app's audit; never opens a device.
use atorch_protocol::firmware::{legacy, Image, Phase, Session};
use serde_json::Value;
use std::{
    fs::File,
    io::{BufRead, BufReader},
};

fn unhex(value: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let value: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    (0..value.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&value[i..i + 2], 16)?))
        .collect()
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let path = std::path::Path::new(args.get(1).ok_or("Firmware path required")?);
    let image = Image::inspect(
        path.file_name().unwrap().to_str().unwrap(),
        std::fs::read(path)?,
    )?;
    let blocks = image.info.blocks;
    let mut session = Session::new(image, 0);
    let mut handle = None;
    let mut actual_writes = Vec::new();
    let mut replies = Vec::new();
    let mut started_at = 0;
    for line in BufReader::new(File::open(args.get(2).ok_or("Capture path required")?)?).lines() {
        let value: Value = serde_json::from_str(&line?)?;
        let Some(raw) = value["hex"].as_str() else {
            continue;
        };
        let bytes = unhex(raw)?;
        let kind = value["kind"].as_str().unwrap_or("");
        let now = value["timeMs"]
            .as_u64()
            .or_else(|| value["timestamp"].as_u64())
            .unwrap_or(0);
        if matches!(kind, "hid_write" | "tx") && bytes.starts_with(&[0x55, 0xaa]) {
            handle = Some(value["handle"].clone());
            started_at = now;
        }
        if handle.as_ref() != Some(&value["handle"]) {
            continue;
        }
        if matches!(kind, "hid_write" | "tx")
            && (bytes.starts_with(&[0x55, 0xaa]) || bytes.starts_with(&[0x55, 0xcc]))
        {
            actual_writes.push(bytes.clone());
        }
        if matches!(kind, "hid_read" | "rx")
            && bytes.len() == 64
            && bytes[0] == 0xaa
            && matches!(bytes[1], 0xbb | 0xdd | 0xee | 0xff | 0x11)
        {
            replies.push((bytes, now));
        }
    }
    // hid_write is logged on return; a fast IN callback can be logged before
    // that return. Compare the ordered TX stream as each engine output occurs,
    // rather than pretending callback log order is the physical bus ordering.
    let mut writes = 0;
    let mut compare = |logical: Vec<u8>| -> Result<(), Box<dyn std::error::Error>> {
        if actual_writes.get(writes).map(Vec::as_slice)
            != Some(legacy::encode(&logical)?.as_slice())
        {
            return Err(format!("Actual write {} differs from generated packet", writes).into());
        }
        writes += 1;
        Ok(())
    };
    compare(session.start(started_at)?)?;
    for (bytes, now) in &replies {
        if let Some(next) = session.receive_usb(bytes, *now)? {
            compare(next)?;
        }
    }
    let reads = replies.len();
    if writes != actual_writes.len() {
        return Err("Capture contains unexpected extra writes".into());
    }
    println!(
        "phase={:?}; acknowledged={}/{}; matched HID writes={}; verified replies={}",
        session.phase, session.acknowledged_blocks, blocks, writes, reads
    );
    if session.phase != Phase::Complete || session.acknowledged_blocks != blocks {
        return Err("Capture does not contain a complete successful upgrade".into());
    }
    Ok(())
}
