package dev.atorch.usb

import android.content.Context
import android.content.pm.PackageManager
import app.tauri.plugin.JSObject
import java.util.concurrent.TimeUnit

/** Opt-in USB role workaround. Probe interfaces only after an explicit Root request. */
internal class RootUsbHost(context: Context) {
    private val preferences = context.getSharedPreferences("atorch-root-usb", Context.MODE_PRIVATE)
    private var selectedPath: String? = null
    private val session = RootUsbSession(
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST),
        object : UsbRoleAccess {
            override fun read(): String {
                if (preferences.getString("originalRole", null) == null) {
                    val intf = UsbRoleInterfaces.select(execute(DISCOVER_ROLES))
                    selectedPath = intf.path
                    return intf.role
                }
                // Recovery always uses the recorded interface, never a fresh probe.
                val path = UsbRoleInterfaces.restorePath(preferences.getString("rolePath", null))
                selectedPath = path
                val role = execute("cat '$path'")
                check(role in listOf("none", "host", "device")) { "无法识别当前 USB 控制器角色" }
                return role
            }

            override fun write(role: String) {
                check(role == "host" || role == "none")
                val path = UsbRoleInterfaces.validatePath(checkNotNull(selectedPath) { "尚未确定 USB 角色接口" })
                val result = execute("printf $role > '$path' && cat '$path'")
                check(result == role) { "USB 角色切换未生效，请检查线缆与设备供电" }
            }
        },
        object : UsbRoleJournal {
            override fun original() = preferences.getString("originalRole", null)
            override fun save(role: String) {
                val path = UsbRoleInterfaces.validatePath(checkNotNull(selectedPath) { "尚未确定 USB 角色接口" })
                check(preferences.edit().putString("originalRole", role).putString("rolePath", path).commit()) {
                    "无法保存 USB 角色恢复记录"
                }
            }
            override fun clear() {
                check(preferences.edit().remove("originalRole").remove("rolePath").commit()) { "无法清除 USB 角色恢复记录" }
                selectedPath = null
            }
        },
    )

    fun status(): JSObject {
        val state = session.status()
        return JSObject().put("supported", state.supported).put("enabled", state.enabled)
            .put("restorePending", state.restorePending).put("error", state.error ?: org.json.JSONObject.NULL)
    }

    fun enabled() = session.status().enabled
    fun enable() = session.enable()
    fun restore() = session.restore()
    fun restoreIfOwned() = session.restoreIfOwned()

    private companion object {
        // Fixed read-only command. Paths and shell commands are never accepted from the WebView.
        const val DISCOVER_ROLES = "for p in /sys/class/usb_role/*/role; do " +
            "[ -f \"${'$'}p\" ] || continue; " +
            "role=${'$'}(cat \"${'$'}p\" 2>/dev/null) || continue; " +
            "w=0; [ -w \"${'$'}p\" ] && w=1; " +
            "printf '%s\\t%s\\t%s\\n' \"${'$'}p\" \"${'$'}role\" \"${'$'}w\"; " +
            "done; exit 0"
    }

    private fun execute(command: String): String {
        val process = try { ProcessBuilder("su", "-c", command).redirectErrorStream(true).start() }
            catch (_: Exception) { error("未找到可用的 Root，请在 Root 管理器中授权 Atorch Load") }
        try {
            process.outputStream.close()
            if (!process.waitFor(40, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                error("Root 授权或操作超时，请在 Root 管理器中检查 Atorch Load 的授权")
            }
            val output = process.inputStream.bufferedReader().use { it.readText() }.trim()
            check(process.exitValue() == 0) {
                "Root 操作未完成，请检查应用授权${if (output.isBlank()) "" else "：${output.take(240)}"}"
            }
            return output
        } finally {
            process.destroy()
            process.inputStream.close()
            process.errorStream.close()
        }
    }
}
