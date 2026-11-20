package dev.atorch.ble

/** Only known load names and the vendor's panel commands are accepted. */
internal object BlePacket {
    private val loadName = Regex("(?:ATORCH[\\s_-]+)?(?:DL24P?|BW600)(?:[\\s_-].*)?", RegexOption.IGNORE_CASE)

    fun isSupportedName(name: String): Boolean = name.trim().let {
        it.startsWith("BW150", ignoreCase = true) || loadName.matches(it)
    }

    fun validate(data: ByteArray) {
        require(data.size == 10) { "蓝牙面板命令长度错误" }
        require(data[0].toInt() and 255 == 255 && data[1].toInt() and 255 == 0x55 &&
            data[2].toInt() and 255 == 0x11 && data[3].toInt() and 255 == 2) { "蓝牙面板命令头错误" }
        require((data[4].toInt() and 255) in listOf(1, 2, 3, 0x31, 0x32, 0x33, 0x34) &&
            (5..8).all { data[it].toInt() == 0 }) { "此蓝牙命令尚未核准" }
        val checksum = ((2..8).sumOf { data[it].toInt() and 255 } xor 0x44) and 255
        require(data[9].toInt() and 255 == checksum) { "蓝牙面板命令校验错误" }
    }
}
