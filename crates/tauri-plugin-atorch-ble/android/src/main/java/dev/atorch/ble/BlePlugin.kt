package dev.atorch.ble

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothManager
import android.bluetooth.le.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.*
import app.tauri.plugin.*
import java.util.concurrent.Executors

@InvokeArg class OpenArgs { lateinit var path: String }
@InvokeArg class ReadArgs { var timeoutMs: Int = 80 }
@InvokeArg class WriteArgs { var data: List<Int> = listOf() }

@SuppressLint("MissingPermission")
@TauriPlugin(permissions = [
    Permission(alias = "nearby", strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT]),
    Permission(alias = "legacyLocation", strings = [Manifest.permission.ACCESS_FINE_LOCATION]),
])
class BlePlugin(private val activity: Activity) : Plugin(activity) {
    private val manager = activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val candidates = linkedMapOf<String, JSObject>()
    private var scanInvoke: Invoke? = null
    private var permissionInvoke: Invoke? = null
    private var scanner: BluetoothLeScanner? = null
    private var callback: ScanCallback? = null
    private var finishScan: Runnable? = null
    // Accessed only on the serial I/O executor.
    private var channel: BleChannel? = null
    @Volatile private var connectedInfo: JSObject? = null

    private fun hasPermission(): Boolean = if (Build.VERSION.SDK_INT >= 31) {
        listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT).all {
            ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED
        }
    } else ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun locationEnabled(): Boolean = ContextCompat.getSystemService(activity, LocationManager::class.java)?.let {
        androidx.core.location.LocationManagerCompat.isLocationEnabled(it)
    } ?: false

    @Command fun status(invoke: Invoke) {
        invoke.resolve(JSObject().put("supported", manager?.adapter != null && activity.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE))
            .put("enabled", runCatching { manager?.adapter?.isEnabled }.getOrNull() ?: org.json.JSONObject.NULL)
            .put("permission", hasPermission()).put("locationRequired", Build.VERSION.SDK_INT < 31)
            .put("locationEnabled", locationEnabled()))
    }
    @Command fun scan(invoke: Invoke) {
        if (!hasPermission()) {
            if (permissionInvoke != null) { invoke.reject("请先完成蓝牙权限确认"); return }
            permissionInvoke = invoke
            requestPermissionForAlias(if (Build.VERSION.SDK_INT >= 31) "nearby" else "legacyLocation", invoke, "scanPermission")
            return
        }
        startScan(invoke)
    }
    @PermissionCallback fun scanPermission(invoke: Invoke) {
        // Closing the device dialog also cancels a scan waiting for permission.
        if (permissionInvoke !== invoke) return
        permissionInvoke = null
        if (!hasPermission()) { invoke.reject("未获得蓝牙扫描权限，请在系统设置中允许附近设备访问后重试"); return }
        startScan(invoke)
    }
    private fun startScan(invoke: Invoke) {
        if (scanInvoke != null) { invoke.reject("蓝牙扫描正在进行，请稍候"); return }
        try {
            val adapter = manager?.adapter ?: error("此设备不支持蓝牙")
            check(adapter.isEnabled) { "请先在系统设置中开启蓝牙" }
            check(Build.VERSION.SDK_INT >= 31 || locationEnabled()) { "此 Android 版本的 BLE 扫描需要开启系统定位服务" }
            val s = adapter.bluetoothLeScanner ?: error("无法启动 BLE 扫描")
            candidates.clear()
            connectedInfo?.let { candidates[it.getString("path")] = it }
            val cb = object : ScanCallback() {
                override fun onScanResult(type: Int, result: ScanResult) { main.post {
                    if (callback !== this || scanInvoke == null) return@post
                    val name = result.scanRecord?.deviceName ?: runCatching { result.device.name }.getOrNull() ?: return@post
                    // Sharing FFE0 alone does not identify a BW150. Never offer
                    // nearby unrelated power meters as a compatible device.
                    if (!name.uppercase().startsWith("BW150")) return@post
                    val path = "ble://${result.device.address}"
                    candidates[path] = JSObject().put("path", path).put("name", name).put("serial", "")
                        .put("vendorId", 0).put("productId", 0).put("transport", "bluetooth").put("rssi", result.rssi)
                } }
                override fun onScanFailed(code: Int) { main.post {
                    if (callback !== this) return@post
                    finish("蓝牙扫描失败（状态 $code），请稍后重试")
                } }
            }
            scanner = s; callback = cb; scanInvoke = invoke
            s.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
            finishScan = Runnable { finish(null) }.also { main.postDelayed(it, 6000) }
        } catch (e: Exception) {
            if (scanInvoke === invoke) finish(e.message ?: "蓝牙扫描失败")
            else invoke.reject(e.message ?: "蓝牙扫描失败")
        }
    }
    private fun finish(error: String?) {
        finishScan?.let(main::removeCallbacks); finishScan = null
        val invoke = scanInvoke
        scanInvoke = null
        val cb = callback; callback = null
        runCatching { if (cb != null) scanner?.stopScan(cb) }
        scanner = null
        if (error != null) invoke?.reject(error)
        else invoke?.resolve(JSObject().put("devices", JSArray().also { a -> candidates.values.forEach { a.put(it) } }))
    }
    @Command fun stopScan(invoke: Invoke) {
        permissionInvoke?.reject("蓝牙扫描已取消"); permissionInvoke = null
        finish(null); invoke.resolve()
    }

    private fun perform(invoke: Invoke, action: () -> JSObject) = io.execute {
        try { invoke.resolve(action()) } catch (e: Exception) { invoke.reject(e.message ?: "蓝牙操作失败") }
    }
    @Command fun open(invoke: Invoke) {
        val path = invoke.parseArgs(OpenArgs::class.java).path
        val info = candidates[path]
        if (info == null || !path.matches(Regex("ble://([0-9A-F]{2}:){5}[0-9A-F]{2}"))) {
            invoke.reject("请先扫描并选择 BW150 蓝牙设备"); return
        }
        finish(null)
        perform(invoke) {
            check(hasPermission()) { "蓝牙权限已撤销，请重新扫描" }
            closeChannel()
            val device = manager?.adapter?.getRemoteDevice(path.removePrefix("ble://")) ?: error("蓝牙不可用")
            val next = BleChannel()
            next.connect(activity, device)
            try {
                ContextCompat.startForegroundService(activity, Intent(activity, BleConnectionService::class.java))
            } catch (e: Exception) {
                next.close()
                throw e
            }
            channel = next
            connectedInfo = info
            info
        }
    }
    @Command fun read(invoke: Invoke) {
        val args = invoke.parseArgs(ReadArgs::class.java)
        perform(invoke) {
            val data = (channel ?: error("蓝牙已断开")).read(args.timeoutMs)
            JSObject().put("data", JSArray().also { a -> data.forEach { a.put(it.toInt() and 255) } })
        }
    }
    @Command fun write(invoke: Invoke) {
        val args = invoke.parseArgs(WriteArgs::class.java)
        if (args.data.any { it !in 0..255 }) { invoke.reject("蓝牙命令字节无效"); return }
        perform(invoke) {
            val bytes = args.data.map { it.toByte() }.toByteArray()
            BlePacket.validate(bytes)
            (channel ?: error("蓝牙已断开")).write(bytes)
            JSObject()
        }
    }
    private fun closeChannel() {
        try {channel?.close()} finally {
            channel = null; connectedInfo = null
            activity.stopService(Intent(activity, BleConnectionService::class.java))
        }
    }
    @Command fun close(invoke: Invoke) = perform(invoke) { closeChannel(); JSObject() }
    override fun onDestroy(activity: AppCompatActivity) {
        finish("应用已关闭")
        permissionInvoke?.reject("应用已关闭"); permissionInvoke = null
        io.execute { closeChannel() }
        io.shutdown()
    }
}
