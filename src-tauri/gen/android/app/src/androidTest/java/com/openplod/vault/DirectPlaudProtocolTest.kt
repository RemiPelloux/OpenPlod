package com.openplod.vault

import org.junit.Assert.*
import org.junit.Test

class DirectPlaudProtocolTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun rejected(block: () -> Unit) {
        try { block() } catch (_: Exception) { return }
        fail("Unsafe or malformed input was accepted")
    }
    private fun material() = ByteArray(32) { 7 } + ByteArray(12) { 3 } + ByteArray(12) { 5 } + hex("bbea0c32d2ba19b0fc2584562a17f81b2978a3b15c8bf8e4")
    @Test fun safeCommandsAndFraming() {
        assertArrayEquals(hex("011a00"), DirectPlaudProtocol.command(26, byteArrayOf()))
        rejected { DirectPlaudProtocol.command(0xfe20, byteArrayOf()) }
        rejected { DirectPlaudProtocol.chunks(0xfe20, byteArrayOf(1)) }
        rejected { DirectPlaudProtocol.chunks(0xfe10, byteArrayOf()) }
        val chunks = DirectPlaudProtocol.chunks(0xfe12, ByteArray(201) { 4 })
        assertEquals(3, chunks.size); assertEquals(104, chunks[0].size)
        assertArrayEquals(hex("12fe030204"), chunks[2])
    }
    @Test fun independentCryptoKitFixtureAndReplayProtection() {
        val packet = hex("eaa64d67978e5840f3cd7315f9c4762025d028e0833515")
        DirectCipher(material()).use { cipher ->
            rejected { cipher.decrypt(packet.copyOf().also { it[4] = (it[4].toInt() xor 1).toByte() }) }
            assertArrayEquals(hex("011a00"), cipher.decrypt(packet))
            rejected { cipher.decrypt(packet) }
        }
        rejected { DirectCipher(material().also { it[79] = (it[79].toInt() xor 1).toByte() }) }
        rejected { DirectCipher(ByteArray(79)) }
        val closed = DirectCipher(material()); closed.close()
        rejected { closed.encrypt(hex("011a00")) }
    }
    private fun page(request: Long, total: Int, offset: Int, vararg ids: Long): ByteArray =
        hex("011a00") + le32(request) + byteArrayOf(total.toByte(), 0, offset.toByte(), 0) +
            ids.flatMap { (le32(it) + le32(100) + byteArrayOf(0, 0)).toList() }.toByteArray()
    @Test fun paginationAndMalformedResponses() {
        val pages = DirectPages(7)
        assertNull(pages.add(page(7, 3, 2, 30)))
        assertNull(pages.add(page(7, 3, 2, 30)))
        rejected { pages.add(page(8, 3, 0, 10)) }
        rejected { pages.add(page(7, 4, 0, 10)) }
        rejected { pages.add(page(7, 3, 2, 40)) }
        assertEquals(listOf(10L, 20L, 30L), pages.add(page(7, 3, 0, 10, 20))!!.map { it.sessionId })
        assertTrue(DirectPages(1).add(page(1, 0, 0))!!.isEmpty())
        rejected { DirectPages(1).add(page(1, 2, 0, 10, 10)) }
        rejected { DirectPages(1).add(page(1, 1, 0, 10).dropLast(1).toByteArray()) }
        rejected { DirectPlaudProtocol.playbackOgg(byteArrayOf(1, 2)) }
    }
}
