package dev.atorch.usb

internal data class UsbRoleInterface(val path: String, val role: String, val writable: Boolean)

/** Read-only discovery output; selection must finish before any role is changed. */
internal object UsbRoleInterfaces {
    // Recovery records from the initial, fixed-path implementation have no path key.
    const val LEGACY_ROLE_PATH = "/sys/class/usb_role/a600000.ssusb-role-switch/role"
    private val pathPattern = Regex("/sys/class/usb_role/[A-Za-z0-9_][A-Za-z0-9_.:@+\\-]*/role")

    fun validatePath(path: String): String {
        check(pathPattern.matches(path)) { "USB 角色接口路径无效，请检查系统 USB 配置" }
        return path
    }

    fun restorePath(recordedPath: String?) = validatePath(recordedPath ?: LEGACY_ROLE_PATH)

    fun select(output: String): UsbRoleInterface {
        val interfaces = output.lineSequence().filter { it.isNotBlank() }.map { line ->
            val parts = line.split('\t')
            check(parts.size == 3) { "无法识别 USB 角色接口信息" }
            val path = validatePath(parts[0])
            check(parts[1] in listOf("none", "host", "device") && parts[2] in listOf("0", "1")) {
                "无法识别当前 USB 控制器角色"
            }
            UsbRoleInterface(path, parts[1], parts[2] == "1")
        }.toList()
        check(interfaces.isNotEmpty()) { "未找到可用的 USB 角色接口，此系统暂无法使用 Root 直连，请使用 OTG 连接" }
        check(interfaces.size == 1) { "检测到多个 USB 角色接口，无法确定连接端口，请使用 OTG 连接" }
        return interfaces.single().also {
            check(it.writable) { "USB 角色接口不可写，请检查 Root 授权或使用 OTG 连接" }
        }
    }
}
