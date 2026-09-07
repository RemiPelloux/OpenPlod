package com.openplod.vault

import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicLong

class DirectPlaudConnection(private val transport: DirectPlaudTransport, private val identity: JSONObject) : AutoCloseable {
    private var cipher: DirectCipher? = null
    private fun decode(name: String) = Base64.decode(identity.getString(name), Base64.NO_WRAP)
    fun establish(progress: (String) -> Unit) {
        transport.connect(identity.getString("serial"), progress)
        progress("authenticating")
        DirectPlaudProtocol.chunks(0xfe10, decode("signature")).forEach { transport.write(it) }
        val chunks = mutableMapOf<Int, ByteArray>()
        var sent = false; var count: Int? = null
        val deadline = System.currentTimeMillis() + 30000
        while (System.currentTimeMillis() < deadline) {
            val bytes = transport.packet(minOf(10000, deadline - System.currentTimeMillis()))
            require(bytes.size >= 2) { "Truncated authorization packet." }
            if (bytes.u16(0) == 0xfe11 && !sent) {
                DirectPlaudProtocol.chunks(0xfe12, identity.getString("publicKey").toByteArray()).forEach { transport.write(it) }; sent = true
            } else if (bytes.u16(0) == 0xfe12) {
                require(bytes.size in 5..104 && bytes.u8(2) in 1..3 && bytes.u8(3) < bytes.u8(2) && (count == null || count == bytes.u8(2))) { "Malformed key exchange." }
                count = bytes.u8(2); val index = bytes.u8(3); val part = bytes.copyOfRange(4, bytes.size)
                require(chunks[index] == null || chunks[index]!!.contentEquals(part)) { "Conflicting key response." }; chunks[index] = part
                if (chunks.size == count) {
                    val encrypted = (0 until count!!).fold(byteArrayOf()) { result, i -> result + chunks.getValue(i) }
                    val key = decode("privateKey")
                    val material = try { DirectPlaudProtocol.unwrap(key, encrypted) } finally { key.fill(0) }
                    try { cipher = DirectCipher(material) } finally { material.fill(0) }
                    handshake(); progress("ready"); return
                }
            } else error("Unexpected authorization response (opcode ${bytes.u16(0)}, length ${bytes.size}).")
        }
        error("Plaud authorization timed out.")
    }
    private fun write(bytes: ByteArray) = transport.write(checkNotNull(cipher).encrypt(bytes))
    private fun packet(timeout: Long = 15000) = checkNotNull(cipher).decrypt(transport.packet(timeout))
    private fun handshake() {
        val request = DirectPlaudProtocol.command(1, byteArrayOf(2, 0, 0) + identity.getString("bindingToken").toByteArray(Charsets.US_ASCII))
        write(request); var second = false
        val deadline = System.currentTimeMillis() + 15000
        while (System.currentTimeMillis() < deadline) {
            val reply = packet(deadline - System.currentTimeMillis())
            require(reply.size >= 3 && reply.u8(0) == 1) { "Malformed handshake." }
            if (reply.u16(1) == 2 && !second) { require(reply.size >= 59); second = true; request[5] = 1; write(request) }
            else if (reply.u16(1) == 1) {
                require(reply.size >= 12 && reply.u8(3) == 0) { "Plaud rejected the existing device authorization." }
                require(reply.u16(4) == 20 && reply.u8(11) == 1 && reply.u8(8) in 1..2) { "Unsupported negotiated audio protocol." }; return
            }
        }
        error("Recording authorization timed out.")
    }
    fun list(): List<DirectSession> {
        val id = sequence.incrementAndGet() and 0xffffffffL
        val pages = DirectPages(id)
        write(DirectPlaudProtocol.command(26, le32(id) + le32(0) + byteArrayOf(0)))
        val deadline = System.currentTimeMillis() + 15000
        while (System.currentTimeMillis() < deadline) {
            val bytes = packet(deadline - System.currentTimeMillis())
            if (bytes.size >= 3 && bytes.u8(0) == 1 && bytes.u16(1) == 26) pages.add(bytes)?.let { return it }
        }
        error("Recording list timed out; count is unknown.")
    }
    fun download(session: DirectSession, directory: File, progress: (Int) -> Unit): File {
        require(session.size in 513..64L * 1024 * 1024) { "Recording exceeds the 64 MiB transfer limit." }
        directory.mkdirs()
        val stem = "${identity.getString("serial")}-${session.sessionId}-${session.size}"
        val original = File(directory, "$stem.plaud")
        val part = File(directory, "$stem.part")
        var tailVerified = original.length() == session.size
        if (!tailVerified) RandomAccessFile(part, "rw").use { file ->
            // Keep a contiguous, fsynced prefix. Re-request the final byte to require a fresh transfer tail.
            val offset = minOf(file.length(), session.size - 1)
            file.setLength(offset); file.seek(offset)
            var position = offset; var head = false
            write(DirectPlaudProtocol.command(28, le32(session.sessionId) + le32(offset) + le32(session.size)))
            val deadline = System.currentTimeMillis() + 15 * 60000
            try {
                while (!tailVerified && System.currentTimeMillis() < deadline) {
                    val bytes = packet()
                    if (bytes.size >= 3 && bytes.u8(0) == 1 && bytes.u16(1) in setOf(28, 29)) {
                        val op = bytes.u16(1)
                        require(bytes.size >= if (op == 28) 8 else 9) { "Truncated download control." }
                        require(bytes.u32(3) == session.sessionId) { "Recording transfer mismatch." }
                        if (op == 28) { require(!head && bytes.u8(7) == 0) { "Plaud rejected the download range." }; head = true }
                        else { require(head && position == session.size) { "Incomplete recording transfer." }; tailVerified = true }
                    } else if (bytes.isNotEmpty() && bytes.u8(0) == 2) {
                        require(head && bytes.size >= 10 && bytes.u32(1) == session.sessionId) { "Invalid recording data." }
                        val at = bytes.u32(5); val length = bytes.u8(9)
                        if (at == 0xffffffffL) { require(bytes.size >= 11 && bytes.u8(10) == 1) { "Plaud stopped transfer." }; continue }
                        require(at == position && length > 0 && bytes.size == length + 10 && position + length <= session.size) { "Noncontiguous recording packet." }
                        file.write(bytes, 10, length); position += length
                        progress((position * 95 / session.size).toInt())
                    }
                }
                check(tailVerified) { "Download timed out. Partial audio retained for retry." }
            } finally { file.fd.sync() }
        }
        if (!original.isFile) check(part.renameTo(original)) { "Could not retain original bytes." }
        val privateKey = decode("privateKey")
        val audio = try { DirectPlaudProtocol.decode(original.readBytes()) { DirectPlaudProtocol.unwrap(privateKey, it) } } finally { privateKey.fill(0) }
        check(list().any { it.sessionId == session.sessionId && it.size == session.size }) { "Source retention could not be verified." }
        val output = File(directory, "$stem.ogg")
        RandomAccessFile(output, "rw").use { it.setLength(0); it.write(audio); it.fd.sync() }
        progress(98)
        return output
    }
    override fun close() { cipher?.close(); cipher = null; transport.close() }
    companion object { private val sequence = AtomicLong(System.currentTimeMillis() / 1000) }
}
