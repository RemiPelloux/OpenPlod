package com.openplod.vault

import org.bouncycastle.asn1.pkcs.RSAPrivateKey
import org.bouncycastle.crypto.engines.ChaCha7539Engine
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import java.security.KeyFactory
import java.security.spec.RSAPrivateCrtKeySpec
import javax.crypto.Cipher

internal fun ByteArray.u8(at: Int): Int = this[at].toInt() and 255
internal fun ByteArray.u16(at: Int): Int = u8(at) or (u8(at + 1) shl 8)
internal fun ByteArray.u32(at: Int): Long = (0..3).fold(0L) { value, i -> value or (u8(at + i).toLong() shl (8 * i)) }
internal fun le32(value: Long): ByteArray {
    require(value in 0..0xffffffffL)
    return ByteArray(4) { (value shr (it * 8)).toByte() }
}
data class DirectSession(val sessionId: Long, val size: Long, val scene: Int, val timezone: Int)

object DirectPlaudProtocol {
    fun command(op: Int, payload: ByteArray): ByteArray {
        require(op in setOf(1, 26, 28)) { "Unsafe or unsupported Plaud command." }
        return byteArrayOf(1, op.toByte(), 0) + payload
    }
    fun chunks(op: Int, bytes: ByteArray): List<ByteArray> {
        require(op == 0xfe10 || op == 0xfe12) { "Unsafe pre-handshake command." }
        val total = (bytes.size + 99) / 100
        require(total in 1..255)
        return (0 until total).map { byteArrayOf(op.toByte(), (op shr 8).toByte(), total.toByte(), it.toByte()) + bytes.copyOfRange(it * 100, minOf(bytes.size, (it + 1) * 100)) }
    }
    fun advertisement(bytes: ByteArray): String? {
        if (bytes.size < 22 || bytes.u8(2) != 2 || bytes.u8(5) != 4 || bytes.u8(10) != 8 || bytes.u16(3) !in setOf(881, 883) || bytes.u16(20) != 20) return null
        return bytes.copyOfRange(11, 19).joinToString("") { "%02X".format(it) }
    }
    fun unwrap(keyBytes: ByteArray, data: ByteArray): ByteArray {
        require(data.size == 256) { "Invalid RSA ciphertext." }
        val key = RSAPrivateKey.getInstance(keyBytes)
        val spec = RSAPrivateCrtKeySpec(key.modulus, key.publicExponent, key.privateExponent, key.prime1, key.prime2, key.exponent1, key.exponent2, key.coefficient)
        return Cipher.getInstance("RSA/ECB/PKCS1Padding").run { init(Cipher.DECRYPT_MODE, KeyFactory.getInstance("RSA").generatePrivate(spec)); doFinal(data) }
    }
    fun decode(bytes: ByteArray, unwrap: (ByteArray) -> ByteArray): ByteArray {
        require(bytes.size > 512 && String(bytes, 0, 8, Charsets.US_ASCII) == "PLAUD.AI" && bytes.u16(8) == 1 && bytes.u16(10) == 512 && bytes.u16(48) == 1 && bytes.u16(52) == 1) { "Unsupported Plaud audio format." }
        val channels = bytes.u16(50)
        require(channels in 1..2 && bytes.u32(128) == 0L) { "Unsupported audio channels or counter." }
        val key = unwrap(bytes.copyOfRange(256, 512))
        try {
            require(key.size == 32) { "Audio key does not match this identity." }
            val engine = ChaCha7539Engine()
            engine.init(false, ParametersWithIV(KeyParameter(key), bytes.copyOfRange(132, 144)))
            val audio = ByteArray(bytes.size - 512)
            engine.processBytes(bytes, 512, audio.size, audio, 0)
            validateOgg(audio, channels)
            return audio
        } finally { key.fill(0) }
    }
    fun validateOgg(audio: ByteArray, channels: Int) {
        var offset = 0; var opus = false
        val streams = mutableMapOf<Long, Pair<Long, Boolean>>()
        while (offset < audio.size) {
            require(offset + 27 <= audio.size && String(audio, offset, 4, Charsets.US_ASCII) == "OggS" && audio.u8(offset + 4) == 0) { "Invalid Ogg page." }
            val headerEnd = offset + 27 + audio.u8(offset + 26)
            require(headerEnd <= audio.size) { "Incomplete Ogg table." }
            val length = (offset + 27 until headerEnd).sumOf { audio.u8(it) }
            val end = headerEnd + length
            require(end <= audio.size) { "Incomplete Ogg payload." }
            val page = audio.copyOfRange(offset, end)
            val expected = page.u32(22)
            page.fill(0, 22, 26)
            var crc = 0
            for (b in page) { crc = crc xor ((b.toInt() and 255) shl 24); repeat(8) { crc = (crc shl 1) xor if (crc < 0) 0x04c11db7 else 0 } }
            require((crc.toLong() and 0xffffffffL) == expected) { "Ogg integrity check failed." }
            val serial = page.u32(14); val seq = page.u32(18); val flags = page.u8(5); val previous = streams[serial]
            require(if (previous == null) seq == 0L && flags and 2 != 0 else !previous.second && seq == previous.first + 1 && flags and 2 == 0) { "Discontinuous Ogg audio." }
            streams[serial] = Pair(seq, flags and 4 != 0)
            if (previous == null && length >= 19 && String(audio, headerEnd, 8, Charsets.US_ASCII) == "OpusHead") {
                require(audio.u8(headerEnd + 9) == channels) { "Opus channel mismatch." }; opus = true
            }
            offset = end
        }
        require(opus && streams.isNotEmpty() && streams.values.all { it.second }) { "Incomplete Opus recording." }
    }
    fun playbackOgg(audio: ByteArray): ByteArray {
        val pages = mutableListOf<Pair<Long, ByteArray>>()
        val opusStreams = mutableMapOf<Long, Int>()
        var offset = 0
        while (offset < audio.size) {
            require(offset + 27 <= audio.size) { "Incomplete Ogg header." }
            val headerEnd = offset + 27 + audio.u8(offset + 26)
            require(headerEnd <= audio.size)
            val length = (offset + 27 until headerEnd).sumOf { audio.u8(it) }
            require(headerEnd + length <= audio.size)
            val serial = audio.u32(offset + 14)
            if (audio.u8(offset + 5) and 2 != 0 && length >= 19 && String(audio, headerEnd, 8, Charsets.US_ASCII) == "OpusHead") opusStreams[serial] = audio.u8(headerEnd + 9)
            pages.add(Pair(serial, audio.copyOfRange(offset, headerEnd + length)))
            offset = headerEnd + length
        }
        require(opusStreams.size == 1) { "Multiple Opus tracks are not supported on this phone." }
        val stream = opusStreams.entries.single()
        validateOgg(audio, stream.value)
        // Android's extractor rejects Plaud's extra metadata stream. Keep audio pages unchanged.
        val output = java.io.ByteArrayOutputStream()
        pages.filter { it.first == stream.key }.forEach { output.write(it.second) }
        return output.toByteArray().also { validateOgg(it, stream.value) }
    }
}

class DirectCipher(material: ByteArray) : AutoCloseable {
    private val key: ByteArray
    private val nonce: ByteArray
    private val aad: ByteArray
    private var send = 1L
    private var receive = -1L
    private var closed = false
    init {
        require(material.size == 80) { "Invalid session material." }
        key = material.copyOfRange(0, 32); nonce = material.copyOfRange(32, 44); aad = material.copyOfRange(44, 56)
        try { require(crypt(false, material.copyOfRange(56, 80)).contentEquals("PLAUD.AI".toByteArray())) { "Invalid verification marker." } }
        catch (e: Exception) { close(); throw IllegalStateException("Plaud key verification failed.") }
    }
    private fun crypt(encrypt: Boolean, bytes: ByteArray): ByteArray {
        check(!closed) { "Session closed." }
        val cipher = ChaCha20Poly1305()
        cipher.init(encrypt, AEADParameters(KeyParameter(key), 128, nonce, aad))
        val out = ByteArray(cipher.getOutputSize(bytes.size))
        val n = cipher.processBytes(bytes, 0, bytes.size, out, 0)
        val total = n + cipher.doFinal(out, n)
        return out.copyOf(total)
    }
    fun encrypt(bytes: ByteArray): ByteArray { check(send < 0xffffffffL && bytes.size >= 3); return crypt(true, le32(++send) + bytes) }
    fun decrypt(bytes: ByteArray): ByteArray {
        val plain = crypt(false, bytes)
        require(plain.size >= 7 && plain.u32(0) > receive) { "Replayed or malformed Plaud response." }
        receive = plain.u32(0)
        return plain.copyOfRange(4, plain.size)
    }
    override fun close() { closed = true; key.fill(0); nonce.fill(0); aad.fill(0) }
}

class DirectPages(private val request: Long) {
    private var total: Int? = null
    private val entries = mutableMapOf<Int, DirectSession>()
    fun add(bytes: ByteArray): List<DirectSession>? {
        require(bytes.size >= 11 && bytes.u8(0) == 1 && bytes.u16(1) == 26 && bytes.u32(3) == request) { "Invalid recording-list response." }
        val count = bytes.u16(7); val offset = bytes.u16(9)
        require((total == null || total == count) && (bytes.size - 11) % 10 == 0 && offset + (bytes.size - 11) / 10 <= count) { "Recording list changed or was truncated." }
        total = count
        for (i in 11 until bytes.size step 10) {
            val entry = DirectSession(bytes.u32(i), bytes.u32(i + 4), bytes.u8(i + 9), bytes.u8(i + 8))
            val position = offset + (i - 11) / 10
            require(entries[position] == null || entries[position] == entry) { "Conflicting list page." }
            entries[position] = entry
        }
        if (entries.size != count) return null
        val result = (0 until count).map { entries.getValue(it) }
        require(result.map { it.sessionId }.toSet().size == count) { "Duplicate recording sessions." }
        return result
    }
}
