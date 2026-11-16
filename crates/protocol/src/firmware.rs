//! Vendor bootloader protocol (logical packets, before the USB envelope).
//! Real BW150 IAP captures confirm a 64-byte envelope that omits the high CRC
//! byte on full blocks. `legacy` validates that format and the echoed file data.
//! No function in this crate opens or writes a real device.
pub mod legacy;
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const BLOCK_SIZE: usize = 58;
/// File-size limit used by the vendor PC application's file picker.
pub const MAX_IMAGE_SIZE: usize = 1_024_000;
const AC632_HEADER: &[u8] = b"\xdc\xee\xbf\x1d0.01\xf0\x31\xac\x67\xc5\xad\xff\x68AC632N";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FirmwareError {
    #[error("固件文件为空或超过官方程序的 1,024,000 字节上限")]
    Size,
    #[error("升级应答长度或类型无效")]
    Frame,
    #[error("升级应答 CRC16 校验失败")]
    Crc,
    #[error("设备拒绝升级（11）")]
    Rejected,
    #[error("升级应答顺序或分块序号不一致")]
    Sequence,
    #[error("升级应答超时；未继续发送后续分块")]
    Timeout,
    #[error("升级流程已结束或取消")]
    Terminal,
}

pub fn crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0xffff;
    for &byte in bytes {
        crc ^= byte as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xa001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn packet(kind: u8, payload: &[u8]) -> Vec<u8> {
    let length = payload.len() + 4;
    let mut result = vec![0; 64];
    result[..2].copy_from_slice(&[kind, length as u8]);
    result[2..2 + payload.len()].copy_from_slice(payload);
    let crc = crc16(&result[..length - 2]);
    result[length - 2..length].copy_from_slice(&crc.to_le_bytes());
    result
}

/// Application-mode broadcast recovered at MainDialog 0x41c0d0. This changes
/// device mode; it is documented/exported only, never sent by rehearsal.
pub fn enter_bootloader() -> [u8; 64] {
    let mut result = [0; 64];
    result[..9].copy_from_slice(&[0x55, 5, 9, 2, 0, 0, 0, 0xee, 0xff]);
    result
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    pub name: String,
    pub bytes: usize,
    pub sha256: String,
    pub crc16: String,
    pub family: String,
    pub filename_model: Option<String>,
    pub blocks: u16,
    pub last_block_bytes: usize,
    pub remainder: u8,
    pub handshake_hex: String,
    pub first_block_hex: String,
    pub last_block_hex: String,
    pub boot_entry_hex: String,
    pub hardware_write_available: bool,
    pub limitation: String,
}

pub struct Image {
    pub info: FirmwareInfo,
    bytes: Vec<u8>,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

impl Image {
    pub fn inspect(name: &str, bytes: Vec<u8>) -> Result<Self, FirmwareError> {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_SIZE {
            return Err(FirmwareError::Size);
        }
        let blocks = bytes.len().div_ceil(BLOCK_SIZE) as u16;
        let remainder = (bytes.len() % BLOCK_SIZE) as u8;
        let upper = name.to_uppercase();
        let model = ["BW150", "BW600", "DL24", "CW24", "CW20"]
            .into_iter()
            .find(|model| upper.starts_with(model));
        let mut image = Self {
            info: FirmwareInfo {
                name: name.into(),
                bytes: bytes.len(),
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                crc16: format!("{:04X}", crc16(&bytes)),
                family: if bytes.starts_with(AC632_HEADER) {
                    "AC632N"
                } else {
                    "二进制固件"
                }
                .into(),
                filename_model: model.map(str::to_owned),
                blocks,
                last_block_bytes: if remainder == 0 {
                    BLOCK_SIZE
                } else {
                    remainder as usize
                },
                remainder,
                handshake_hex: String::new(),
                first_block_hex: String::new(),
                last_block_hex: String::new(),
                boot_entry_hex: hex(&enter_bootloader()[..9]),
                hardware_write_available: false,
                limitation: "实机刷写由 Windows / Android USB 服务提供。".into(),
            },
            bytes,
        };
        image.info.handshake_hex = hex(&image.handshake()[..7]);
        image.info.first_block_hex = hex(&image.block(0).unwrap());
        image.info.last_block_hex = hex(&image.block(blocks - 1).unwrap());
        Ok(image)
    }
    pub fn handshake(&self) -> Vec<u8> {
        let mut payload = self.info.blocks.to_le_bytes().to_vec();
        payload.push(self.info.remainder);
        packet(0xaa, &payload)
    }
    pub fn block(&self, index: u16) -> Result<Vec<u8>, FirmwareError> {
        if index >= self.info.blocks {
            return Err(FirmwareError::Sequence);
        }
        let start = index as usize * BLOCK_SIZE;
        let mut payload = index.to_le_bytes().to_vec();
        payload.extend_from_slice(&self.bytes[start..(start + BLOCK_SIZE).min(self.bytes.len())]);
        Ok(packet(0xcc, &payload))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    Ready,
    Block(u16),
    TransferComplete,
    Complete,
    Rejected,
}
pub fn parse_reply(bytes: &[u8]) -> Result<Reply, FirmwareError> {
    if bytes.len() < 4 || bytes.len() > 64 {
        return Err(FirmwareError::Frame);
    }
    let length = bytes[1] as usize;
    if !(4..=64).contains(&length) || length > bytes.len() {
        return Err(FirmwareError::Frame);
    }
    if crc16(&bytes[..length - 2]) != u16::from_le_bytes([bytes[length - 2], bytes[length - 1]]) {
        return Err(FirmwareError::Crc);
    }
    match (bytes[0], length) {
        (0xbb, _) => Ok(Reply::Ready),
        (0xdd, 6..=64) => Ok(Reply::Block(u16::from_le_bytes([bytes[2], bytes[3]]))),
        (0xee, _) => Ok(Reply::TransferComplete),
        (0xff, _) => Ok(Reply::Complete),
        (0x11, _) => Ok(Reply::Rejected),
        _ => Err(FirmwareError::Frame),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Ready,
    Handshake,
    Transferring,
    AwaitingTransferComplete,
    Writing,
    Complete,
    Failed,
    Cancelled,
}

pub struct Session {
    image: Image,
    pub phase: Phase,
    pub acknowledged_blocks: u16,
    pending: Option<Vec<u8>>,
    sent_at: u64,
    retries: u8,
    max_retries: u8,
}
impl Session {
    /// Default caller uses zero retries, matching the vendor. An explicit
    /// bounded retry policy only retransmits the identical outstanding packet.
    pub fn new(image: Image, max_retries: u8) -> Self {
        Self {
            image,
            phase: Phase::Ready,
            acknowledged_blocks: 0,
            pending: None,
            sent_at: 0,
            retries: 0,
            max_retries: max_retries.min(3),
        }
    }
    pub fn start(&mut self, now: u64) -> Result<Vec<u8>, FirmwareError> {
        if self.phase != Phase::Ready {
            return Err(FirmwareError::Sequence);
        }
        self.phase = Phase::Handshake;
        Ok(self.send(self.image.handshake(), now))
    }
    fn send(&mut self, frame: Vec<u8>, now: u64) -> Vec<u8> {
        self.pending = Some(frame.clone());
        self.sent_at = now;
        self.retries = 0;
        frame
    }
    pub fn receive(&mut self, bytes: &[u8], now: u64) -> Result<Option<Vec<u8>>, FirmwareError> {
        if matches!(
            self.phase,
            Phase::Failed | Phase::Cancelled | Phase::Complete | Phase::Ready
        ) {
            return Err(FirmwareError::Terminal);
        }
        let reply = parse_reply(bytes)?;
        if reply == Reply::Rejected {
            self.phase = Phase::Failed;
            self.pending = None;
            return Err(FirmwareError::Rejected);
        }
        match (self.phase, reply) {
            (Phase::Handshake, Reply::Ready) => {
                self.phase = Phase::Transferring;
                Ok(Some(self.send(self.image.block(0)?, now)))
            }
            (Phase::Transferring, Reply::Block(index)) if index == self.acknowledged_blocks => {
                self.acknowledged_blocks += 1;
                if self.acknowledged_blocks < self.image.info.blocks {
                    Ok(Some(
                        self.send(self.image.block(self.acknowledged_blocks)?, now),
                    ))
                } else {
                    self.phase = Phase::AwaitingTransferComplete;
                    self.pending = None;
                    self.sent_at = now;
                    Ok(None)
                }
            }
            (Phase::Transferring | Phase::AwaitingTransferComplete, Reply::Block(index))
                if self.acknowledged_blocks > 0 && index == self.acknowledged_blocks - 1 =>
            {
                Ok(None)
            }
            (Phase::Transferring, Reply::Ready) if self.acknowledged_blocks == 0 => Ok(None),
            (Phase::Transferring | Phase::AwaitingTransferComplete, Reply::TransferComplete)
                if self.acknowledged_blocks as usize + 1 >= self.image.info.blocks as usize =>
            {
                // Vendor may replace the final DD with EE.
                self.acknowledged_blocks = self.image.info.blocks;
                self.phase = Phase::Writing;
                self.pending = None;
                self.sent_at = now;
                Ok(None)
            }
            (Phase::Writing, Reply::TransferComplete) => Ok(None),
            (Phase::Writing, Reply::Complete) => {
                self.phase = Phase::Complete;
                Ok(None)
            }
            _ => Err(FirmwareError::Sequence),
        }
    }
    pub fn receive_usb(
        &mut self,
        report: &[u8],
        now: u64,
    ) -> Result<Option<Vec<u8>>, FirmwareError> {
        let logical = legacy::decode(&self.image, report)?;
        self.receive(&logical, now)
    }
    pub fn tick(&mut self, now: u64) -> Result<Option<Vec<u8>>, FirmwareError> {
        if matches!(
            self.phase,
            Phase::Complete | Phase::Cancelled | Phase::Failed
        ) {
            return Ok(None);
        }
        if self.phase == Phase::Ready {
            return Ok(None);
        }
        let timeout = if self.phase == Phase::Writing {
            30_000
        } else {
            10_000
        };
        if now.saturating_sub(self.sent_at) < timeout {
            return Ok(None);
        }
        if let Some(frame) = &self.pending {
            if self.retries < self.max_retries {
                self.retries += 1;
                self.sent_at = now;
                return Ok(Some(frame.clone()));
            }
        }
        self.phase = Phase::Failed;
        self.pending = None;
        Err(FirmwareError::Timeout)
    }
    pub fn cancel(&mut self) {
        if !matches!(self.phase, Phase::Complete | Phase::Failed) {
            self.phase = Phase::Cancelled;
            self.pending = None;
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rehearsal {
    pub offline: bool,
    pub phase: Phase,
    pub blocks: u16,
    pub acknowledged_blocks: u16,
    pub transferred_bytes: usize,
    pub events: Vec<String>,
}

pub fn rehearse(image: Image) -> Result<Rehearsal, FirmwareError> {
    rehearse_usb(image)
}

/// Exercise the same USB envelope as the live path without a transport.
fn rehearse_usb(image: Image) -> Result<Rehearsal, FirmwareError> {
    fn reply(mut logical: Vec<u8>, kind: u8) -> Vec<u8> {
        logical[0] = kind;
        let n = logical[1] as usize;
        let crc = crc16(&logical[..n - 2]);
        logical[n - 2..n].copy_from_slice(&crc.to_le_bytes());
        let mut wire = vec![0xaa];
        wire.extend_from_slice(&logical[..63]);
        wire
    }
    let (blocks, bytes) = (image.info.blocks, image.info.bytes);
    let mut session = Session::new(image, 0);
    let handshake = session.start(0)?;
    legacy::encode(&handshake)?;
    let mut frame = session
        .receive_usb(&reply(handshake, 0xbb), 1)?
        .ok_or(FirmwareError::Sequence)?;
    for index in 0..blocks {
        let wire = legacy::encode(&frame)?;
        let n = frame[1] as usize;
        let start = index as usize * BLOCK_SIZE;
        if wire[0] != 0x55
            || u16::from_le_bytes([wire[3], wire[4]]) != index
            || wire[5..n - 1] != session.image.bytes[start..(start + BLOCK_SIZE).min(bytes)]
        {
            return Err(FirmwareError::Sequence);
        }
        let kind = if index + 1 == blocks { 0xee } else { 0xdd };
        if let Some(next) = session.receive_usb(&reply(frame.clone(), kind), index as u64 + 2)? {
            frame = next;
        }
    }
    session.receive_usb(&reply(packet(0xff, &[0, 0]), 0xff), blocks as u64 + 3)?;
    Ok(Rehearsal {
        offline: true,
        phase: session.phase,
        blocks,
        acknowledged_blocks: session.acknowledged_blocks,
        transferred_bytes: bytes,
        events: vec![
            "离线构造 64 字节 USB AA 握手，使用实测 55 前缀".into(),
            "模拟 BB：校验回显的块数、余数与 CRC".into(),
            format!("校验 {blocks} 个 CC / DD 的数据回显、序号及实测可用 CRC 字节"),
            "模拟末块 EE：确认最后数据并等待烧写".into(),
            "模拟 FF：核对零状态及 CRC（全程未访问真实 USB）".into(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(size: usize) -> Image {
        let mut bytes = vec![0x5a; size];
        bytes[..AC632_HEADER.len()].copy_from_slice(AC632_HEADER);
        Image::inspect("BW150-test.bin", bytes).unwrap()
    }
    #[test]
    fn usb_rehearsal_covers_full_and_partial_blocks_without_a_transport() {
        for size in [64, 116, 117, 643072] {
            let result = rehearse_usb(image(size)).unwrap();
            assert!(result.offline);
            assert_eq!(result.phase, Phase::Complete);
            assert_eq!(
                result.acknowledged_blocks as usize,
                size.div_ceil(BLOCK_SIZE)
            );
            assert_eq!(result.transferred_bytes, size);
        }
    }
    #[test]
    fn modbus_known_vector_and_exact_wire_packets() {
        assert_eq!(crc16(b"123456789"), 0x4b37);
        let image = image(116);
        assert_eq!(&image.handshake()[..5], &[0xaa, 7, 2, 0, 0]);
        let block = image.block(1).unwrap();
        assert_eq!(&block[..4], &[0xcc, 64, 1, 0]);
        assert_eq!(&block[4..62], &[0x5a; 58]);
        assert_eq!(
            u16::from_le_bytes([block[62], block[63]]),
            crc16(&block[..62])
        );
        assert_eq!((image.info.blocks, image.info.last_block_bytes), (2, 58));
        assert_eq!(
            &enter_bootloader()[..9],
            &[0x55, 5, 9, 2, 0, 0, 0, 0xee, 0xff]
        );
    }
    #[test]
    fn partial_block_and_inspection_use_vendor_file_size_rules() {
        let image = image(117);
        let block = image.block(2).unwrap();
        assert_eq!(&block[..5], &[0xcc, 7, 2, 0, 0x5a]);
        assert!(block[7..].iter().all(|v| *v == 0));
        assert_eq!(image.info.sha256.len(), 64);
        assert_eq!(image.info.filename_model.as_deref(), Some("BW150"));
        assert!(!image.info.hardware_write_available);
        assert!(matches!(
            Image::inspect("empty.bin", vec![]),
            Err(FirmwareError::Size)
        ));
        let binary = Image::inspect("custom.bin", vec![0; 128]).unwrap();
        assert_eq!(binary.info.family, "二进制固件");
        assert_eq!(binary.info.filename_model, None);
        let maximum = Image::inspect("BW600-custom.bin", vec![0; MAX_IMAGE_SIZE]).unwrap();
        assert_eq!(maximum.info.bytes, 1_024_000);
        assert!(matches!(
            Image::inspect("BW150.bin", vec![0; MAX_IMAGE_SIZE + 1]),
            Err(FirmwareError::Size)
        ));
    }
    #[test]
    fn arbitrary_binary_files_and_modified_images_use_the_live_usb_rehearsal() {
        for size in [1, 22, 57, 58, 59, 64, 116, 117] {
            let image = Image::inspect("experiment.bin", vec![0xa5; size]).unwrap();
            let result = rehearse(image).unwrap();
            assert!(result.offline);
            assert_eq!(result.phase, Phase::Complete);
            assert_eq!(result.acknowledged_blocks as usize, size.div_ceil(58));
            assert_eq!(result.transferred_bytes, size);
            assert!(result.events[0].contains("64 字节 USB"));
        }
    }
    #[test]
    fn state_machine_requires_crc_sequence_and_final_device_completion() {
        let mut s = Session::new(image(117), 0);
        s.start(0).unwrap();
        assert_eq!(
            s.receive(&packet(0xff, &[]), 1),
            Err(FirmwareError::Sequence)
        );
        let mut bad = packet(0xbb, &[]);
        bad[3] ^= 1;
        assert_eq!(s.receive(&bad, 1), Err(FirmwareError::Crc));
        assert_eq!(s.phase, Phase::Handshake);
        let first = s.receive(&packet(0xbb, &[]), 2).unwrap().unwrap();
        assert_eq!(&first[..4], &[0xcc, 64, 0, 0]);
        assert!(s.receive(&packet(0xbb, &[]), 3).unwrap().is_none());
        assert_eq!(
            s.receive(&packet(0xdd, &1u16.to_le_bytes()), 3),
            Err(FirmwareError::Sequence)
        );
        s.receive(&packet(0xdd, &0u16.to_le_bytes()), 4).unwrap();
        assert!(s
            .receive(&packet(0xdd, &0u16.to_le_bytes()), 5)
            .unwrap()
            .is_none());
        assert_eq!(s.acknowledged_blocks, 1);
        assert_eq!(
            s.receive(&packet(0xee, &[]), 6),
            Err(FirmwareError::Sequence)
        );
        s.receive(&packet(0xdd, &1u16.to_le_bytes()), 7).unwrap();
        s.receive(&packet(0xee, &[]), 8).unwrap();
        assert_eq!(s.phase, Phase::Writing);
        s.receive(&packet(0xff, &[]), 9).unwrap();
        assert_eq!(s.phase, Phase::Complete);
        assert_eq!(s.acknowledged_blocks, 3);
    }
    #[test]
    fn timeout_retries_identical_packet_and_stops_at_bound() {
        let mut s = Session::new(image(117), 1);
        let sent = s.start(0).unwrap();
        assert!(s.tick(9999).unwrap().is_none());
        assert_eq!(s.tick(10000).unwrap(), Some(sent));
        assert_eq!(s.tick(20000), Err(FirmwareError::Timeout));
        assert_eq!(s.phase, Phase::Failed);
        assert_eq!(
            s.receive(&packet(0xbb, &[]), 20001),
            Err(FirmwareError::Terminal)
        );
    }
    #[test]
    fn rejection_cancellation_and_missing_final_reply_never_succeed() {
        let mut s = Session::new(image(64), 0);
        s.start(0).unwrap();
        assert_eq!(
            s.receive(&packet(0x11, &[]), 1),
            Err(FirmwareError::Rejected)
        );
        assert_eq!(s.phase, Phase::Failed);
        let mut s = Session::new(image(64), 0);
        s.start(0).unwrap();
        s.cancel();
        assert!(s.tick(99000).unwrap().is_none());
        assert_eq!(
            s.receive(&packet(0xbb, &[]), 1),
            Err(FirmwareError::Terminal)
        );
        let mut s = Session::new(image(64), 0);
        s.start(0).unwrap();
        s.receive(&packet(0xbb, &[]), 1).unwrap();
        s.receive(&packet(0xdd, &0u16.to_le_bytes()), 2).unwrap();
        s.receive(&packet(0xee, &[]), 3).unwrap();
        assert_eq!(s.tick(30003), Err(FirmwareError::Timeout));
    }
    #[test]
    fn full_rehearsal_checks_every_byte_and_partial_boundary() {
        for size in [64, 115, 116, 117, 643072] {
            let r = rehearse(image(size)).unwrap();
            assert!(r.offline);
            assert_eq!(r.phase, Phase::Complete);
            assert_eq!(r.blocks, r.acknowledged_blocks);
            assert_eq!(r.transferred_bytes, size);
        }
    }
}
