package com.openplod.vault

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

class DirectPlaudIdentity(private val context: Context) {
    private val keys get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val file get() = AtomicFile(File(context.noBackupFilesDir, "plaud-identity.enc"))
    fun configured() = file.baseFile.isFile
    private fun wrappingKey(): SecretKey {
        val name = "openplod.plaud.storage"
        (keys.getKey(name, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); generateKey()
        }
    }
    fun save(identity: JSONObject) {
        validate(identity)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, wrappingKey()) }
        val data = cipher.iv + cipher.doFinal(identity.toString().toByteArray())
        val output = file.startWrite()
        try { output.write(data); file.finishWrite(output) } catch (e: Exception) { file.failWrite(output); throw e }
    }
    fun read(): JSONObject {
        check(configured()) { "Authorize this phone from OpenPlod on your Mac first." }
        val bytes = file.openRead().use { it.readBytes() }
        require(bytes.size > 28) { "Saved device authorization is damaged." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        val plain = cipher.doFinal(bytes.copyOfRange(12, bytes.size))
        try { return JSONObject(String(plain, Charsets.UTF_8)).also { validate(it) } } finally { plain.fill(0) }
    }
    fun enrollmentKey(): String {
        val alias = "openplod.plaud.enrollment"
        if (!keys.containsAlias(alias)) KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_DECRYPT).setKeySize(2048).setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP).build())
        }.generateKeyPair()
        return Base64.encodeToString(keys.getCertificate(alias).publicKey.encoded, Base64.NO_WRAP)
    }
    fun accept(envelope: JSONObject, requestId: String) {
        val decode = { name: String -> Base64.decode(envelope.getString(name), Base64.NO_WRAP) }
        val unwrap = Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
            init(Cipher.DECRYPT_MODE, keys.getKey("openplod.plaud.enrollment", null), OAEPParameterSpec("SHA-1", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT))
        }
        val key = unwrap.doFinal(decode("wrappedKey"))
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, decode("iv")))
                updateAAD(requestId.toByteArray())
            }
            val plain = cipher.doFinal(decode("ciphertext"))
            try { save(JSONObject(String(plain, Charsets.UTF_8))) } finally { plain.fill(0) }
        } finally { key.fill(0) }
    }
    private fun validate(value: JSONObject) {
        require(value.getString("serial").matches(Regex("[0-9A-F]{16}")) && value.getString("bindingToken").matches(Regex("[!-~]{32}"))) { "Invalid device authorization." }
        require(Base64.decode(value.getString("signature"), Base64.NO_WRAP).size == 256 && value.getString("publicKey").isNotBlank() && Base64.decode(value.getString("privateKey"), Base64.NO_WRAP).size in 1000..1400) { "Incomplete device authorization." }
    }
}
