package dev.atorch.usb

import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbRequest
import android.os.SystemClock
import java.io.Closeable
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.TimeoutException

/** One connection, used only by UsbPlugin's serial I/O executor. */
internal class InterruptChannel(
    private val connection: UsbDeviceConnection,
    private val intf: UsbInterface,
    input: UsbEndpoint,
    output: UsbEndpoint,
) : Closeable {
    private val reader = UsbRequest()
    private val writer = UsbRequest()
    private val readBuffer = ByteBuffer.allocateDirect(64)
    private val writeBuffer = ByteBuffer.allocateDirect(64)
    private val received = ArrayDeque<ByteArray>()
    private var reading = false
    private var writing = false
    private var written = 0
    private var closed = false

    init {
        try {
            check(reader.initialize(connection, input)) { "无法创建 USB 读取请求" }
            check(writer.initialize(connection, output)) { "无法创建 USB 写入请求" }
        } catch (e: Exception) {
            close()
            throw e
        }
    }

    private fun complete(timeoutMs: Long): Boolean {
        val request = try { connection.requestWait(timeoutMs.coerceAtLeast(1)) }
            catch (_: TimeoutException) { return false }
        checkNotNull(request) { "USB 设备已断开" }
        when (request) {
            reader -> {
                reading = false
                val count = readBuffer.position()
                readBuffer.flip()
                if (count > 0) received.add(ByteArray(count).also { readBuffer.get(it) })
            }
            writer -> { writing = false; written = writeBuffer.position() }
            else -> error("收到未知 USB 请求")
        }
        return true
    }

    fun read(timeoutMs: Int): ByteArray {
        check(!closed) { "USB 已断开，请重新连接" }
        if (received.isNotEmpty()) return received.removeFirst()
        if (!reading) {
            readBuffer.clear()
            check(reader.queue(readBuffer)) { "USB 读取提交失败" }
            reading = true
        }
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (received.isEmpty()) {
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0 || !complete(remaining)) return byteArrayOf()
        }
        // A timeout only ends this poll. The queued request and its buffer stay
        // alive until requestWait returns it, including across a later write.
        return received.removeFirst()
    }

    fun write(bytes: ByteArray) {
        check(!closed) { "USB 已断开，请重新连接" }
        check(!writing) { "上一 USB 写入尚未完成" }
        writeBuffer.clear()
        writeBuffer.put(bytes)
        writeBuffer.flip()
        check(writer.queue(writeBuffer)) { "USB 写入提交失败" }
        writing = true
        val deadline = SystemClock.elapsedRealtime() + 1000
        while (writing) {
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0 || !complete(remaining)) {
                close()
                error("USB 写入超时，请重新连接设备")
            }
            // requestWait may return the pending IN request while waiting for
            // OUT. Keep that report for the next Rust read instead of losing it.
        }
        check(written == bytes.size) { "USB 写入长度异常：$written" }
    }

    fun reportDescriptor(): ByteArray {
        check(!closed) { "USB 已断开" }
        val bytes = ByteArray(512)
        val count = connection.controlTransfer(0x81, 6, 0x2200, intf.id, bytes, bytes.size, 1000)
        check(count > 0) { "无法读取 HID 报告描述符" }
        return bytes.copyOf(count)
    }

    override fun close() {
        if (closed) return
        closed = true
        try {
            if (reading) reader.cancel()
            if (writing) writer.cancel()
            // Cancellation is asynchronous. Reap completed requests before
            // freeing them; freeing a queued request crashes usb_request_wait.
            val deadline = SystemClock.elapsedRealtime() + 250
            while (reading || writing) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) break
                if (!complete(remaining)) break
            }
            if (!reading && !writing) connection.releaseInterface(intf)
        } catch (_: Exception) {
            // Removal may make cancellation/reaping fail. Closing the device
            // ends outstanding kernel I/O before request resources are freed.
        } finally {
            connection.close()
            reader.close()
            writer.close()
            reading = false
            writing = false
            received.clear()
        }
    }
}
