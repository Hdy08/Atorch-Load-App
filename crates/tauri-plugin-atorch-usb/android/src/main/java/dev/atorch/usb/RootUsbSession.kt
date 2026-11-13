package dev.atorch.usb

internal interface UsbRoleAccess {
    fun read(): String
    fun write(role: String)
}

internal interface UsbRoleJournal {
    fun original(): String?
    fun save(role: String)
    fun clear()
}

internal data class RootUsbStatus(
    val supported: Boolean,
    val enabled: Boolean,
    val restorePending: Boolean,
    val error: String?,
)

/** Serialized by UsbPlugin's I/O executor. Construction/status never invoke su. */
internal class RootUsbSession(
    private val supported: Boolean,
    private val roles: UsbRoleAccess,
    private val journal: UsbRoleJournal,
) {
    private var enabled = false
    private var error: String? = null

    fun status() = RootUsbStatus(supported, enabled, !enabled && journal.original() != null, error)

    fun enable() {
        if (enabled) return
        try {
            check(supported) { "此设备不支持 USB Host，无法使用 Root 直连" }
            check(journal.original() == null) { "上次 USB 角色尚未恢复，请先点击恢复 USB 角色" }
            val original = roles.read()
            // Do not take over an existing host/device session, including USB
            // tethering or a phone connected to a PC. Only own our transition.
            check(original == "none") { "USB 当前处于 $original 模式，请先断开其它 USB 连接" }
            journal.save(original)
            try {
                roles.write("host")
            } catch (changeError: Exception) {
                try { restore() }
                catch (restoreError: Exception) {
                    throw IllegalStateException("${changeError.message}；恢复失败：${restoreError.message}，请重试恢复 USB 角色")
                }
                throw changeError
            }
            enabled = true
            error = null
        } catch (e: Exception) {
            error = e.message ?: "无法启用 Root USB-C 直连"
            throw e
        }
    }

    fun restoreIfOwned() {
        if (enabled) restore()
    }

    fun restore() {
        enabled = false
        val original = journal.original() ?: run { error = null; return }
        try {
            check(supported && original == "none") { "USB 恢复记录无效，请检查当前 USB 模式" }
            when (val current = roles.read()) {
                original -> Unit // The system already restored it.
                "host" -> roles.write(original)
                else -> error("USB 已被系统切换为 $current 模式，未覆盖该设置；请断开 USB 后重试恢复")
            }
            journal.clear()
            error = null
        } catch (e: Exception) {
            error = e.message ?: "USB 角色恢复失败，请重试"
            throw e
        }
    }
}
