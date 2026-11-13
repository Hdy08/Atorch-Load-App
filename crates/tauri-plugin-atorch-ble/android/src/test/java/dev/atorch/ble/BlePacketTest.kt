package dev.atorch.ble

import org.junit.Test

class BlePacketTest {
    private fun frame(code: Int): ByteArray {
        val data = byteArrayOf(-1, 0x55, 0x11, 2, code.toByte(), 0, 0, 0, 0, 0)
        data[9] = ((0x11 + 2 + code) xor 0x44).toByte()
        return data
    }
    @Test fun knownPanelCommandsAreAccepted() {
        listOf(1, 2, 3, 0x31, 0x32, 0x33, 0x34).forEach { BlePacket.validate(frame(it)) }
    }
    @Test(expected = IllegalArgumentException::class) fun usbQueryIsRejected() { BlePacket.validate(byteArrayOf(0x55, 5, 1, 3, 11, 0, -116, -18, -1)) }
    @Test(expected = IllegalArgumentException::class) fun unsupportedMeterBacklightIsRejected() { BlePacket.validate(frame(0x21)) }
    @Test(expected = IllegalArgumentException::class) fun invalidChecksumIsRejected() { BlePacket.validate(frame(0x33).also { it[9] = 0 }) }
    @Test(expected = IllegalArgumentException::class) fun nonzeroPayloadIsRejected() { BlePacket.validate(frame(0x33).also { it[8] = 1; it[9] = 3 }) }
}
