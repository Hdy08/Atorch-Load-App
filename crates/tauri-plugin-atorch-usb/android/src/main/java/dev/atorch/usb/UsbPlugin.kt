package dev.atorch.usb

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.*
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors
import java.io.ByteArrayOutputStream

@InvokeArg class OpenArgs { lateinit var path: String }
@InvokeArg class WriteArgs { var data: List<Int> = emptyList() }
@InvokeArg class ReadArgs { var timeoutMs: Int = 80 }
@InvokeArg class SaveArgs { lateinit var name: String; lateinit var content: String }
@InvokeArg class SavePngArgs { lateinit var name: String; lateinit var data: String }
private data class DocumentSave(val name: String, val type: String, val data: ByteArray)
@InvokeArg class RootUsbArgs { var enabled: Boolean = false }
@InvokeArg class FirmwareSessionArgs { var enabled: Boolean = false; var success: Boolean = false }
@InvokeArg class ChartFullscreenArgs { var enabled: Boolean = false }

@TauriPlugin
class UsbPlugin(private val activity: Activity) : Plugin(activity) {
    private val chartFullscreen = ChartFullscreen(activity as AppCompatActivity)
    private val manager = activity.getSystemService(Context.USB_SERVICE) as UsbManager
    private val io = Executors.newSingleThreadExecutor()
    private val files = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val rootUsb = RootUsbHost(activity)
    private val permissionAction = "${activity.packageName}.USB_PERMISSION"
    private var pendingOpen: Pair<UsbDevice, Invoke>? = null
    private var pendingSave: Pair<DocumentSave, Invoke>? = null
    private var pendingPick: Invoke? = null
    // Accessed only on the I/O executor.
    private var channel: InterruptChannel? = null
    private var devicePath: String? = null
    // I/O executor owns this flag; hold Host across APP -> IAP -> APP.
    private var firmwareSession = false
    private val firmwareBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            android.widget.Toast.makeText(activity, "固件升级进行中，请等待完成", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    private fun supported(d: UsbDevice) = d.vendorId == 0x0483 && d.productId == 0x5750
    private fun device(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != permissionAction) return
            val pending = pendingOpen ?: return
            if (device(intent)?.deviceName != pending.first.deviceName) return
            pendingOpen = null
            if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) && manager.hasPermission(pending.first)) {
                perform(pending.second) { openWithCleanup(pending.first); JSObject() }
            } else perform(pending.second) {
                releaseDevice()
                error("未获得 USB 访问权限，请重新连接并允许访问 BW150")
            }
        }
    }
    private val detachReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val detached = device(intent) ?: return
            io.execute {
                if (devicePath == detached.deviceName || (supported(detached) && rootUsb.enabled() && !firmwareSession)) {
                    runCatching { releaseDevice() }
                }
            }
            pendingOpen?.takeIf { it.first.deviceName == detached.deviceName }?.let {
                pendingOpen = null; it.second.reject("USB 设备已移除")
            }
        }
    }

    init {
        val owner = activity as AppCompatActivity
        owner.onBackPressedDispatcher.addCallback(owner, firmwareBack)
        ContextCompat.registerReceiver(activity, permissionReceiver, IntentFilter(permissionAction), ContextCompat.RECEIVER_NOT_EXPORTED)
        ContextCompat.registerReceiver(activity, detachReceiver, IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED), ContextCompat.RECEIVER_EXPORTED)
    }

    private fun perform(invoke: Invoke, operation: () -> JSObject) {
        io.execute {
            try { invoke.resolve(operation()) }
            catch (e: Exception) { invoke.reject(e.message ?: "USB 操作失败") }
        }
    }

    override fun load(webView: WebView) { chartFullscreen.load(webView) }

    override fun onResume(activity: AppCompatActivity) { chartFullscreen.resume() }

    @Command fun setChartFullscreen(invoke: Invoke) {
        val args = invoke.parseArgs(ChartFullscreenArgs::class.java)
        activity.runOnUiThread {
            try { chartFullscreen.setEnabled(args.enabled); invoke.resolve(JSObject()) }
            catch (e: Exception) { invoke.reject(e.message ?: "无法切换全屏") }
        }
    }

    @Command fun discover(invoke: Invoke) = perform(invoke) {
        val list = JSArray()
        manager.deviceList.values.filter(::supported).forEach { d ->
            val serial = if (manager.hasPermission(d)) runCatching { d.serialNumber }.getOrNull() ?: "" else ""
            list.put(JSObject().put("path", d.deviceName).put("name", d.productName ?: "ATORCH BW150")
                .put("serial", serial).put("vendorId", d.vendorId).put("productId", d.productId))
        }
        JSObject().put("devices", list)
    }

    @Command fun diagnostics(invoke: Invoke) = perform(invoke) {
        // Enumeration does not require USB permission. Report every device so
        // an absent USB link is distinguishable from an unsupported VID/PID.
        val list = JSArray()
        manager.deviceList.values.forEach { d ->
            list.put(JSObject().put("path", d.deviceName)
                .put("name", runCatching { d.productName }.getOrNull() ?: "USB 设备")
                .put("vendorId", d.vendorId).put("productId", d.productId)
                .put("supported", supported(d)).put("permission", manager.hasPermission(d)))
        }
        JSObject().put("hostSupported", activity.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST))
            .put("devices", list).put("rootUsb", rootUsb.status())
    }

    @Command fun rootUsbHost(invoke: Invoke) {
        val args = invoke.parseArgs(RootUsbArgs::class.java)
        perform(invoke) {
            check(!firmwareSession) { "固件升级期间不能切换 USB 角色" }
            check(pendingOpen == null) { "请先完成 USB 访问授权" }
            if (args.enabled) {
                check(channel == null) { "请先断开当前设备" }
                check(manager.deviceList.isEmpty()) { "已识别 USB 外设，请直接连接；无需启用 Root 直连" }
                rootUsb.enable()
            } else {
                closeDevice()
                rootUsb.restore()
            }
            rootUsb.status()
        }
    }

    @Command fun firmwareProfile(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        perform(invoke) {
            val d = manager.deviceList.values.find { it.deviceName == args.path && supported(it) }
                ?: error("设备已移除，请重新扫描")
            val hid = (0 until d.interfaceCount).map(d::getInterface).any { intf ->
                val endpoints = (0 until intf.endpointCount).map(intf::getEndpoint)
                intf.interfaceClass == UsbConstants.USB_CLASS_HID &&
                    endpoints.any { it.type == UsbConstants.USB_ENDPOINT_XFER_INT && it.direction == UsbConstants.USB_DIR_IN && it.maxPacketSize == 64 } &&
                    endpoints.any { it.type == UsbConstants.USB_ENDPOINT_XFER_INT && it.direction == UsbConstants.USB_DIR_OUT && it.maxPacketSize == 64 }
            }
            check(hid) { "此设备没有支持的 64 字节 USB HID 接口" }
            val iap = when {
                d.manufacturerName == "APP" -> false
                d.manufacturerName == "IAP" -> true
                else -> error("无法识别设备的 APP / IAP USB 接口")
            }
            JSObject().put("iap", iap)
        }
    }

    @Command fun firmwareSession(invoke: Invoke) {
        val args = invoke.parseArgs(FirmwareSessionArgs::class.java)
        perform(invoke) {
            check(pendingOpen == null) { "请先完成 USB 访问授权" }
            if (args.enabled) {
                check(!firmwareSession) { "已有 USB 固件维护会话" }
                firmwareSession = true
            } else {
                firmwareSession = false
                if (!args.success) releaseDevice()
            }
            activity.runOnUiThread {
                firmwareBack.isEnabled = args.enabled
                if (args.enabled) activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            JSObject()
        }
    }

    @Command fun reportDescriptor(invoke: Invoke) = perform(invoke) {
        val bytes = (channel ?: error("USB 已断开")).reportDescriptor()
        JSObject().put("data", JSArray().also { a -> bytes.forEach { a.put(it.toInt() and 0xff) } })
    }

    @Command fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        val d = manager.deviceList.values.find { it.deviceName == args.path && supported(it) }
        if (d == null) { invoke.reject("设备已移除，请重新扫描"); return }
        if (pendingOpen != null) { invoke.reject("请先完成 USB 权限确认"); return }
        if (manager.hasPermission(d)) { perform(invoke) { openWithCleanup(d); JSObject() }; return }
        pendingOpen = d to invoke
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val intent = PendingIntent.getBroadcast(activity, 0, Intent(permissionAction).setPackage(activity.packageName), flags)
        manager.requestPermission(d, intent)
        main.postDelayed({
            if (pendingOpen?.second === invoke) {
                pendingOpen = null
                perform(invoke) { releaseDevice(); error("USB 权限请求超时，请重试") }
            }
        }, 60_000)
    }

    private fun openDevice(d: UsbDevice) {
        closeDevice()
        for (i in 0 until d.interfaceCount) {
            val intf = d.getInterface(i)
            val endpoints = (0 until intf.endpointCount).map(intf::getEndpoint)
            val read = endpoints.find { it.type == UsbConstants.USB_ENDPOINT_XFER_INT && it.direction == UsbConstants.USB_DIR_IN && it.maxPacketSize >= 64 }
            val write = endpoints.find { it.type == UsbConstants.USB_ENDPOINT_XFER_INT && it.direction == UsbConstants.USB_DIR_OUT && it.maxPacketSize >= 64 }
            if (read == null || write == null) continue
            val c = manager.openDevice(d) ?: error("无法打开 USB 设备，请检查 OTG 连接与访问权限")
            if (!c.claimInterface(intf, true)) { c.close(); error("无法独占 USB HID 接口") }
            channel = InterruptChannel(c, intf, read, write)
            devicePath = d.deviceName
            return
        }
        error("设备未提供 64 字节 HID 中断收发端点")
    }

    private fun openWithCleanup(d: UsbDevice) {
        try { openDevice(d) }
        catch (e: Exception) {
            runCatching { releaseDevice() }
            throw e
        }
    }

    private fun closeDevice() {
        channel?.close()
        channel = null; devicePath = null
    }

    private fun releaseDevice() {
        try { closeDevice() }
        finally { if (!firmwareSession) rootUsb.restoreIfOwned() }
    }

    @Command fun write(invoke: Invoke) {
        val args = invoke.parseArgs(WriteArgs::class.java)
        perform(invoke) {
            require(args.data.size == 64 && args.data.all { it in 0..255 }) { "HID 报文必须为 64 字节" }
            (channel ?: error("USB 已断开")).write(args.data.map { it.toByte() }.toByteArray())
            JSObject()
        }
    }
    @Command fun read(invoke: Invoke) {
        val args = invoke.parseArgs(ReadArgs::class.java)
        perform(invoke) {
            val bytes = (channel ?: error("USB 已断开")).read(args.timeoutMs.coerceIn(1, 1000))
            JSObject().put("data", JSArray().also { a -> bytes.forEach { a.put(it.toInt() and 0xff) } })
        }
    }
    @Command fun close(invoke: Invoke) = perform(invoke) { releaseDevice(); JSObject() }

    @Command fun saveCsv(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        saveDocument(invoke, DocumentSave(args.name, "text/csv", args.content.toByteArray(Charsets.UTF_8)))
    }
    @Command fun savePng(invoke: Invoke) {
        val args = invoke.parseArgs(SavePngArgs::class.java)
        try {
            require(args.data.length <= 12_000_000) { "图片数据过大" }
            val data = Base64.decode(args.data, Base64.NO_WRAP)
            require(data.size >= 8 && data.copyOfRange(0, 8).contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 13, 10, 26, 10))) { "无效的 PNG 图片" }
            saveDocument(invoke, DocumentSave(args.name, "image/png", data))
        } catch (e: Exception) { invoke.reject(e.message ?: "无法保存图片") }
    }
    private fun saveDocument(invoke: Invoke, document: DocumentSave) {
        if (pendingSave != null || pendingPick != null) { invoke.reject("请先完成当前文件选择"); return }
        pendingSave = document to invoke
        try {
            startActivityForResult(invoke, Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = document.type; putExtra(Intent.EXTRA_TITLE, document.name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }, "documentSaved")
        } catch (e: Exception) { pendingSave = null; invoke.reject(e.message ?: "无法打开保存窗口") }
    }
    @ActivityCallback fun documentSaved(invoke: Invoke, result: ActivityResult) {
        val pending = pendingSave ?: return
        pendingSave = null
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { pending.second.resolve(JSObject()); return }
        files.execute {
            try {
                val stream = activity.contentResolver.openOutputStream(uri, "wt") ?: error("无法写入所选文件")
                stream.use { it.write(pending.first.data) }
                if (pending.first.type == "text/csv") persistPermission(uri, result.data?.flags ?: 0)
                pending.second.resolve(JSObject().put("uri", uri.toString()))
            } catch (e: Exception) { pending.second.reject(e.message ?: "文件保存失败") }
        }
    }

    private fun persistPermission(uri: Uri, flags: Int) {
        val granted = flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        check(granted and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) { "文件提供程序未授予读取权限" }
        activity.contentResolver.takePersistableUriPermission(uri, granted)
    }

    private fun readDocumentData(uri: Uri): JSObject {
        check(uri.scheme == "content") { "请选择系统文件窗口中的 CSV" }
        val resolver = activity.contentResolver
        var name = "record.csv"
        var modifiedAt = 0L
        resolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                val modifiedIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) modifiedAt = cursor.getLong(modifiedIndex)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                check(sizeIndex < 0 || cursor.isNull(sizeIndex) || cursor.getLong(sizeIndex) <= 50_000_000L) { "此 CSV 超过 50 MB，请分段导入" }
            }
        }
        check(name.endsWith(".csv", ignoreCase = true)) { "请选择 CSV 文件" }
        val bytes = ByteArrayOutputStream().use { output ->
            val input = resolver.openInputStream(uri) ?: error("无法读取所选 CSV")
            input.use {
                val buffer = ByteArray(32 * 1024)
                while (true) {
                    val count = it.read(buffer)
                    if (count < 0) break
                    check(output.size().toLong() + count <= 50_000_000L) { "此 CSV 超过 50 MB" }
                    output.write(buffer, 0, count)
                }
            }
            output.toByteArray()
        }
        return JSObject().put("path", uri.toString()).put("name", name)
            .put("bytes", bytes.size).put("modifiedAt", modifiedAt)
            .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    @Command fun openCsv(invoke: Invoke) {
        if (pendingSave != null || pendingPick != null) { invoke.reject("请先完成当前文件选择"); return }
        pendingPick = invoke
        try {
            startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }, "documentOpened")
        } catch (e: Exception) { pendingPick = null; invoke.reject(e.message ?: "无法打开文件窗口") }
    }

    @ActivityCallback fun documentOpened(invoke: Invoke, result: ActivityResult) {
        val pending = pendingPick ?: return
        pendingPick = null
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { pending.resolve(JSObject()); return }
        files.execute {
            try {
                persistPermission(uri, result.data?.flags ?: 0)
                pending.resolve(JSObject().put("document", readDocumentData(uri)))
            } catch (e: Exception) { pending.reject(e.message ?: "CSV 导入失败") }
        }
    }

    @Command fun readDocument(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        files.execute {
            try { invoke.resolve(readDocumentData(Uri.parse(args.path))) }
            catch (e: Exception) { invoke.reject(e.message ?: "CSV 读取失败，请重新导入") }
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        chartFullscreen.destroy()
        pendingOpen?.second?.reject("应用已关闭"); pendingOpen = null
        pendingSave?.second?.reject("应用已关闭"); pendingSave = null
        pendingPick?.reject("应用已关闭"); pendingPick = null
        activity.unregisterReceiver(permissionReceiver); activity.unregisterReceiver(detachReceiver)
        io.execute { firmwareSession = false; runCatching { releaseDevice() } }; io.shutdown()
        files.shutdown()
    }
}
