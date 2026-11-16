//! BW150 IAP V1.0.2 envelope, verified against a complete official transfer.
//! 64-byte unnumbered HID: TX 55 + logical[..63], RX AA + logical[..63].
//! For a full block only the low CRC byte fits. Match the entire echoed block
//! against the selected image as well; never pretend the missing byte arrived.
use super::{crc16, packet, FirmwareError, Image};

// Captured descriptor forms are reference fixtures, not a device allowlist.
pub const IAP_REPORT_DESCRIPTOR: &[u8] = &[
    0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x09, 0x02, 0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08,
    0x95, 0x40, 0x81, 0x02, 0x09, 0x03, 0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, 0x40, 0x91,
    0x02, 0xc0,
];
/// Direct USB GET_DESCRIPTOR captured on Android. Windows reconstructs the
/// two LOGICAL_MINIMUM(0) items using 8 bits; the device sends 16-bit items.
pub const IAP_RAW_REPORT_DESCRIPTOR: &[u8] = &[
    0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x09, 0x02, 0x16, 0x00, 0x00, 0x26, 0xff, 0x00, 0x75,
    0x08, 0x95, 0x40, 0x81, 0x02, 0x09, 0x03, 0x16, 0x00, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95,
    0x40, 0x91, 0x02, 0xc0,
];
pub fn is_iap_descriptor(bytes: &[u8]) -> bool {
    bytes == IAP_REPORT_DESCRIPTOR || bytes == IAP_RAW_REPORT_DESCRIPTOR
}

pub fn encode(logical: &[u8]) -> Result<[u8; 64], FirmwareError> {
    if logical.len() != 64 || !matches!(logical[0], 0xaa | 0xcc) {
        return Err(FirmwareError::Frame);
    }
    let length = logical[1] as usize;
    if !(4..=64).contains(&length)
        || crc16(&logical[..length - 2])
            != u16::from_le_bytes([logical[length - 2], logical[length - 1]])
    {
        return Err(FirmwareError::Crc);
    }
    let mut report = [0; 64];
    report[0] = 0x55;
    report[1..].copy_from_slice(&logical[..63]);
    Ok(report)
}

pub fn decode(image: &Image, report: &[u8]) -> Result<Vec<u8>, FirmwareError> {
    if report.len() != 64 || report[0] != 0xaa {
        return Err(FirmwareError::Frame);
    }
    let bytes = &report[1..];
    let length = bytes[1] as usize;
    if !(4..=64).contains(&length) {
        return Err(FirmwareError::Frame);
    }
    let expected = match bytes[0] {
        0xbb => {
            let mut reply = image.handshake();
            reply[0] = 0xbb;
            let crc = crc16(&reply[..5]);
            reply[5..7].copy_from_slice(&crc.to_le_bytes());
            reply
        }
        0xdd | 0xee => {
            let index = u16::from_le_bytes([bytes[2], bytes[3]]);
            if bytes[0] == 0xee && index != image.info.blocks - 1 {
                return Err(FirmwareError::Sequence);
            }
            let mut reply = image.block(index)?;
            let n = reply[1] as usize;
            reply[0] = bytes[0];
            let crc = crc16(&reply[..n - 2]);
            reply[n - 2..n].copy_from_slice(&crc.to_le_bytes());
            reply
        }
        // Successful live FF is FF 06 00 00 D0 31. Refuse nonzero status.
        0xff => packet(0xff, &[0, 0]),
        0x11 => {
            // Failure format is not yet captured. A well-formed CRC-protected
            // failure still halts the state machine; never turns into success.
            if length > 63 {
                return Err(FirmwareError::Frame);
            }
            let value = bytes[..length].to_vec();
            super::parse_reply(&value)?;
            return Ok(value);
        }
        _ => return Err(FirmwareError::Frame),
    };
    let expected_length = expected[1] as usize;
    if length != expected_length {
        return Err(FirmwareError::Frame);
    }
    let available = length.min(63);
    if bytes[..available] != expected[..available] {
        return Err(FirmwareError::Crc);
    }
    // Return the verified logical packet for the existing sequence engine.
    // For length=64 its high CRC byte was reconstructed from the known data.
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unhex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
            .collect()
    }
    fn captured_image() -> Image {
        let first = unhex("55cc400000dceebf1d302e3031f031ac67c5adff6841433633324efffffffffffffffffffff3bb5219bf3e7cf80cfda3678ebd5b977a7c5317a5ad4521f36dd3");
        let mut bytes = vec![0xff; 643072];
        bytes[..58].copy_from_slice(&first[5..63]);
        Image::inspect("BW150-live-fixture.bin", bytes).unwrap()
    }
    #[test]
    fn real_first_full_block_and_bb_dd_echo_match_the_captured_usb_bytes() {
        let image = captured_image();
        let first = unhex("55cc400000dceebf1d302e3031f031ac67c5adff6841433633324efffffffffffffffffffff3bb5219bf3e7cf80cfda3678ebd5b977a7c5317a5ad4521f36dd3");
        assert_eq!(encode(&image.block(0).unwrap()).unwrap().as_slice(), first);
        assert_eq!(&image.block(0).unwrap()[62..], &[0xd3, 0x4e]);
        let dd = unhex("aadd400000dceebf1d302e3031f031ac67c5adff6841433633324efffffffffffffffffffff3bb5219bf3e7cf80cfda3678ebd5b977a7c5317a5ad4521f36ddc");
        let logical = decode(&image, &dd).unwrap();
        assert_eq!(&logical[62..], &[0xdc, 0x5f]);
        let mut corrupted = dd.clone();
        corrupted[30] ^= 1;
        assert!(decode(&image, &corrupted).is_err());
        let mut bb = vec![0; 64];
        bb[..8].copy_from_slice(&unhex("aabb07502b1a5e45"));
        decode(&image, &bb).unwrap();
        bb[3] ^= 1;
        assert!(decode(&image, &bb).is_err());
    }
    #[test]
    fn real_tail_ee_and_ff_require_the_last_image_bytes_and_zero_status() {
        assert!(is_iap_descriptor(IAP_REPORT_DESCRIPTOR));
        assert!(is_iap_descriptor(IAP_RAW_REPORT_DESCRIPTOR));
        let mut wrong = IAP_RAW_REPORT_DESCRIPTOR.to_vec();
        wrong[18] = 0x20; // A 32-byte report must not be treated as a known IAP.
        assert!(!is_iap_descriptor(&wrong));
        let image = captured_image();
        let mut ee = vec![0; 64];
        ee[..33].copy_from_slice(&unhex(
            "aaee204f2bffffffffffffffffffffffffffffffffffffffffffffffffffffaf4d",
        ));
        decode(&image, &ee).unwrap();
        ee[3] ^= 1;
        assert!(decode(&image, &ee).is_err());
        let mut ff = vec![0; 64];
        ff[..7].copy_from_slice(&unhex("aaff060000d031"));
        decode(&image, &ff).unwrap();
        ff[3] = 1;
        assert!(decode(&image, &ff).is_err());
    }
}
