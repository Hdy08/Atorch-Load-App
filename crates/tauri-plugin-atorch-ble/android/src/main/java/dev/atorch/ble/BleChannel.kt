package dev.atorch.ble

import android.annotation.SuppressLint
import android.bluetooth.*
import android.content.Context
import java.io.Closeable
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** GATT operations are serialized by the plugin executor, including writes. */
@SuppressLint("MissingPermission")
internal class BleChannel : Closeable {
    companion object {
        val SERVICE: UUID = UUID.fromString("0000ffe0-0000-1000-8000-00805f9b34fb")
        val NOTIFY: UUID = UUID.fromString("0000ffe1-0000-1000-8000-00805f9b34fb")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
    private val ready = CompletableFuture<Unit>()
    private val packets = LinkedBlockingQueue<ByteArray>(128)
    private val closed = AtomicBoolean(false)
    @Volatile private var failure: String? = null
    @Volatile private var gatt: BluetoothGatt? = null
    private val writing = AtomicReference<CompletableFuture<Unit>?>(null)

    private fun fail(message: String) {
        failure = message
        ready.completeExceptionally(IOException(message))
        writing.getAndSet(null)?.completeExceptionally(IOException(message))
    }
    private fun receive(characteristic: BluetoothGattCharacteristic, data: ByteArray) {
        if (closed.get() || characteristic.uuid != NOTIFY || data.isEmpty()) return
        if (data.size > 256 || !packets.offer(data.copyOf())) fail("蓝牙接收缓冲区异常，请重新连接")
    }
    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
            if (closed.get()) return
            if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) {
                fail("蓝牙已断开（状态 $status），请重新连接")
            } else if (state == BluetoothProfile.STATE_CONNECTED && !g.discoverServices()) {
                fail("无法读取蓝牙服务")
            }
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (closed.get()) return
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("读取蓝牙服务失败：$status"); return }
            val c = g.getService(SERVICE)?.getCharacteristic(NOTIFY)
            if (c == null || c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0 ||
                c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE == 0) {
                fail("此设备没有 BW150 的 FFE0 / FFE1 双向服务"); return
            }
            val descriptor = c.getDescriptor(CCCD)
            if (descriptor == null || !g.setCharacteristicNotification(c, true)) {
                fail("无法订阅 BW150 蓝牙数据"); return
            }
            val accepted = if (android.os.Build.VERSION.SDK_INT >= 33) {
                g.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                g.writeDescriptor(descriptor)
            }
            if (!accepted) fail("蓝牙通知订阅提交失败")
        }
        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (closed.get() || descriptor.uuid != CCCD) return
            if (status == BluetoothGatt.GATT_SUCCESS) ready.complete(Unit)
            else fail("蓝牙通知订阅失败：$status")
        }
        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (closed.get() || characteristic.uuid != NOTIFY) return
            val pending = writing.getAndSet(null) ?: return
            if (status == BluetoothGatt.GATT_SUCCESS) pending.complete(Unit)
            else pending.completeExceptionally(IOException("蓝牙写入失败（状态 $status），请核对设备屏幕"))
        }
        @Deprecated("Legacy Android callback")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (android.os.Build.VERSION.SDK_INT < 33) {
                @Suppress("DEPRECATION")
                receive(characteristic, characteristic.value ?: byteArrayOf())
            }
        }
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            receive(characteristic, value)
        }
    }
    fun connect(context: Context, device: BluetoothDevice) {
        try {
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
                ?: error("无法创建蓝牙连接")
            ready.get(12, TimeUnit.SECONDS)
            failure?.let { throw IOException(it) }
        } catch (e: Exception) {
            close()
            throw IOException(e.cause?.message ?: e.message ?: "蓝牙连接超时，请确认设备未被其他应用占用", e)
        }
    }
    fun read(timeoutMs: Int): ByteArray {
        failure?.let { throw IOException(it) }
        check(!closed.get()) { "蓝牙连接已关闭" }
        return packets.poll(timeoutMs.coerceIn(1, 1000).toLong(), TimeUnit.MILLISECONDS) ?: byteArrayOf()
    }
    fun write(data: ByteArray) {
        BlePacket.validate(data)
        failure?.let { throw IOException(it) }
        check(!closed.get()) { "蓝牙连接已关闭" }
        val g = gatt ?: throw IOException("蓝牙连接已关闭")
        val c = g.getService(SERVICE)?.getCharacteristic(NOTIFY) ?: throw IOException("蓝牙服务已失效")
        val completion = CompletableFuture<Unit>()
        check(writing.compareAndSet(null, completion)) { "蓝牙写入正在进行" }
        try {
            val accepted = if (android.os.Build.VERSION.SDK_INT >= 33) {
                g.writeCharacteristic(c, data.copyOf(), BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                c.value = data.copyOf()
                c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                g.writeCharacteristic(c)
            }
            if (!accepted) throw IOException("蓝牙写入未提交，请检查连接")
            completion.get(3, TimeUnit.SECONDS)
        } catch (e: Exception) {
            // Closing on an uncertain write prevents a late callback from being
            // mistaken for the completion of another command. Never retry.
            val message = e.cause?.message ?: e.message ?: "蓝牙写入超时，执行状态未知，请核对设备屏幕"
            fail(message)
            close()
            throw IOException(message, e)
        } finally {
            writing.compareAndSet(completion, null)
        }
    }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        ready.completeExceptionally(IOException("蓝牙连接已关闭"))
        writing.getAndSet(null)?.completeExceptionally(IOException("蓝牙连接已关闭"))
        val g = gatt
        gatt = null
        try { g?.disconnect() } finally { g?.close(); packets.clear() }
    }
}
