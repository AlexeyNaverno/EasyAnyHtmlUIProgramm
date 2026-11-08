// Native Android host for generated EasyApp applications.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Runtime-exception
//
// RUNTIME LIBRARY EXCEPTION
//
// This file is part of the EasyApp runtime that the compiler embeds into every
// generated application. Linking or bundling this runtime with an independent
// application (your HTML/CSS/JS bundle) does not by itself cause that
// application to be covered by the GNU GPL. You may distribute generated
// applications under terms of your choice, provided you comply with the GPL
// for the runtime itself and keep this notice intact.
//
// This exception applies only to the runtime files that are copied into a
// generated application (this bridge, the native hosts and cJSON). The
// compiler proper remains under GPL-3.0-or-later without this exception.
package org.easyapp.runtime

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileNotFoundException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var manifest: JSONObject
    private lateinit var permissions: Set<String>
    private val workers = Executors.newCachedThreadPool()
    private val prefs by lazy { getSharedPreferences("easyapp", MODE_PRIVATE) }

    private var pendingImportId: Int = -1
    private var pendingExportId: Int = -1

    companion object {
        private const val TAG = "EasyApp"
        private const val REQ_IMPORT = 1001
        private const val REQ_EXPORT = 1002
        // Assets are served from this opaque origin so that the page has a
        // stable, secure origin without exposing the file system.
        private const val ASSET_HOST = "appassets.easyapp.internal"
    }

    private var pendingExport: Pair<String, String>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        manifest = JSONObject(String(assets.open("www/__easyapp_manifest.json").readBytes()))
        val arr = manifest.optJSONArray("permissions") ?: JSONArray()
        permissions = (0 until arr.length()).map { arr.getString(it) }.toSet()

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // Network is only reachable when the permission was granted at build time.
            blockNetworkLoads = !permissions.contains("internet")
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(Bridge(), "__easyappNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (uri.host != ASSET_HOST) {
                    // Any non-asset request without the internet permission is denied.
                    if (!permissions.contains("internet")) {
                        return blocked("Network access is not granted for this application")
                    }
                    return null
                }
                val path = uri.path?.trimStart('/')?.ifEmpty { manifest.optString("entry", "index.html") }
                    ?: manifest.optString("entry", "index.html")
                return try {
                    val safe = safeAssetPath(path)
                    val mime = mimeFor(safe)
                    if (mime == "text/html") {
                        // Inject the bridge into the document itself so that
                        // window.easyapp exists BEFORE any page script runs.
                        // Doing this in onPageFinished would be too late.
                        val html = assets.open("www/$safe").use { String(it.readBytes()) }
                        val injected = injectIntoHtml(html)
                        WebResourceResponse("text/html", "utf-8",
                            ByteArrayInputStream(injected.toByteArray()))
                    } else {
                        WebResourceResponse(mime, "utf-8", assets.open("www/$safe"))
                    }
                } catch (e: Exception) {
                    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(),
                        ByteArrayInputStream("Not found: $path".toByteArray()))
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                injectBridge()
            }
        }

        val entry = manifest.optString("entry", "index.html")
        webView.loadUrl("https://$ASSET_HOST/$entry")
    }

    private fun blocked(reason: String) = WebResourceResponse(
        "text/plain", "utf-8", 403, "Forbidden", emptyMap(),
        ByteArrayInputStream(reason.toByteArray())
    )

    /** Reject traversal in asset requests. */
    private fun safeAssetPath(path: String): String {
        val cleaned = path.replace('\\', '/')
        require(!cleaned.startsWith("/")) { "absolute path" }
        val parts = cleaned.split('/').filter { it.isNotEmpty() && it != "." }
        require(parts.none { it == ".." }) { "path traversal" }
        return parts.joinToString("/")
    }

    /**
     * Prepend the manifest, transport and bridge to the HTML document. The
     * script is inserted at the very start of <head> (or before any content)
     * so page scripts can rely on window.easyapp being defined.
     */
    private fun injectIntoHtml(html: String): String {
        val bridge = String(assets.open("www/__easyapp_bridge.js").readBytes())
        val bootstrap = "window.__EASYAPP_MANIFEST__ = $manifest;" +
            "window.__easyappTransport = function (json) { __easyappNative.send(json); };"
        // A literal </script> inside the JS would terminate the tag early.
        val safeJs = (bootstrap + bridge).replace("</script", "<\\/script")
        val tag = "<script>$safeJs</script>"
        val headMatch = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
        if (headMatch != null) {
            val at = headMatch.range.last + 1
            return html.substring(0, at) + tag + html.substring(at)
        }
        val htmlMatch = Regex("<html[^>]*>", RegexOption.IGNORE_CASE).find(html)
        if (htmlMatch != null) {
            val at = htmlMatch.range.last + 1
            return html.substring(0, at) + "<head>" + tag + "</head>" + html.substring(at)
        }
        return tag + html
    }

    /** Fallback for navigations that did not pass through our interceptor. */
    private fun injectBridge() {
        val bootstrap = """
            window.__EASYAPP_MANIFEST__ = ${manifest};
            window.__easyappTransport = function (json) { __easyappNative.send(json); };
        """.trimIndent()
        webView.evaluateJavascript(bootstrap, null)
        val bridge = String(assets.open("www/__easyapp_bridge.js").readBytes())
        webView.evaluateJavascript(bridge, null)
    }

    private fun resolve(id: Int, ok: Boolean, payload: Any?) {
        val encoded = when (payload) {
            null -> "null"
            is JSONObject, is JSONArray -> payload.toString()
            is String -> JSONObject.quote(payload)
            is Boolean, is Int, is Long, is Double -> payload.toString()
            else -> JSONObject.wrap(payload)?.toString() ?: "null"
        }
        val script = "window.__easyappResolve($id, $ok, $encoded);"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun error(id: Int, message: String) =
        resolve(id, false, JSONObject().put("message", message))

    inner class Bridge {
        @JavascriptInterface
        fun send(json: String) {
            val msg = try { JSONObject(json) } catch (e: Exception) { return }
            val id = msg.optInt("id", -1)
            val method = msg.optString("method")
            val params = msg.optJSONObject("params") ?: JSONObject()

            workers.execute {
                try {
                    dispatch(id, method, params)
                } catch (e: SecurityException) {
                    error(id, e.message ?: "Permission denied")
                } catch (e: Exception) {
                    Log.w(TAG, "bridge error in $method", e)
                    error(id, e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    private fun require(permission: String) {
        if (!permissions.contains(permission)) {
            throw SecurityException("Permission \"$permission\" is not granted for this application")
        }
    }

    private fun dispatch(id: Int, method: String, p: JSONObject) {
        when (method) {
            "app.log" -> { Log.i(TAG, p.optString("message")); resolve(id, true, null) }
            "app.exit" -> runOnUiThread { finish() }

            "storage.get" -> resolve(id, true, prefs.getString(p.getString("key"), null))
            "storage.set" -> { prefs.edit().putString(p.getString("key"), p.getString("value")).apply(); resolve(id, true, null) }
            "storage.remove" -> { prefs.edit().remove(p.getString("key")).apply(); resolve(id, true, null) }
            "storage.keys" -> resolve(id, true, JSONArray(prefs.all.keys.toList()))

            "private.read" -> {
                val f = privateFile(p.getString("path"))
                if (!f.exists()) throw FileNotFoundException("No such file: ${p.getString("path")}")
                resolve(id, true, JSONObject().put("data", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)))
            }
            "private.write" -> {
                val f = privateFile(p.getString("path"))
                f.parentFile?.mkdirs()
                f.writeBytes(Base64.decode(p.getString("data"), Base64.DEFAULT))
                resolve(id, true, null)
            }
            "private.list" -> {
                val dir = if (p.optString("path").isEmpty()) filesDir else privateFile(p.getString("path"))
                resolve(id, true, JSONArray((dir.listFiles() ?: emptyArray()).map { it.name }))
            }
            "private.remove" -> { privateFile(p.getString("path")).delete(); resolve(id, true, null) }

            "net.request" -> { require("internet"); netRequest(id, p) }

            "files.import" -> {
                require("files")
                pendingImportId = id
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = p.optString("accept").ifEmpty { "*/*" }
                }
                runOnUiThread { startActivityForResult(intent, REQ_IMPORT) }
            }
            "files.export" -> {
                require("files")
                pendingExportId = id
                pendingExport = Pair(p.getString("name"), p.getString("data"))
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mimeFor(p.getString("name"))
                    putExtra(Intent.EXTRA_TITLE, p.getString("name"))
                }
                runOnUiThread { startActivityForResult(intent, REQ_EXPORT) }
            }

            else -> error(id, "Unknown method: $method")
        }
    }

    private fun privateFile(path: String): File {
        val rel = safeAssetPath(path)
        val f = File(filesDir, rel)
        if (!f.canonicalPath.startsWith(filesDir.canonicalPath + File.separator) &&
            f.canonicalPath != filesDir.canonicalPath) {
            throw SecurityException("Path escapes the private directory")
        }
        return f
    }

    private fun netRequest(id: Int, p: JSONObject) {
        val url = URL(p.getString("url"))
        if (url.protocol != "http" && url.protocol != "https") {
            throw SecurityException("Only http and https requests are allowed")
        }
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = p.optString("method", "GET").uppercase()
        conn.connectTimeout = p.optInt("timeout", 30000)
        conn.readTimeout = p.optInt("timeout", 30000)
        conn.instanceFollowRedirects = true

        p.optJSONObject("headers")?.let { h ->
            for (key in h.keys()) conn.setRequestProperty(key, h.getString(key))
        }

        if (p.has("body")) {
            conn.doOutput = true
            val bytes = if (p.optString("bodyEncoding") == "base64")
                Base64.decode(p.getString("body"), Base64.DEFAULT)
            else p.getString("body").toByteArray()
            conn.outputStream.use { it.write(bytes) }
        }

        val status = conn.responseCode
        val stream = if (status in 200..399) conn.inputStream else (conn.errorStream ?: ByteArrayInputStream(ByteArray(0)))
        val body = stream.use { it.readBytes() }
        val headers = JSONObject()
        conn.headerFields?.forEach { (k, v) ->
            if (k != null && v.isNotEmpty()) headers.put(k, v.joinToString(", "))
        }
        resolve(id, true, JSONObject()
            .put("status", status)
            .put("statusText", conn.responseMessage ?: "")
            .put("headers", headers)
            .put("body", Base64.encodeToString(body, Base64.NO_WRAP)))
        conn.disconnect()
    }

    @Deprecated("Legacy onActivityResult keeps the runtime dependency-free")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data?.data == null) {
            if (requestCode == REQ_IMPORT && pendingImportId >= 0) { resolve(pendingImportId, true, null); pendingImportId = -1 }
            if (requestCode == REQ_EXPORT && pendingExportId >= 0) {
                error(pendingExportId, "Export cancelled")
                pendingExportId = -1
                pendingExport = null
            }
            return
        }
        val uri: Uri = data.data!!
        workers.execute {
            try {
                when (requestCode) {
                    REQ_IMPORT -> {
                        val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                        val name = displayName(uri)
                        resolve(pendingImportId, true, JSONObject()
                            .put("name", name)
                            .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
                        pendingImportId = -1
                    }
                    REQ_EXPORT -> {
                        val pending = pendingExport ?: return@execute
                        contentResolver.openOutputStream(uri)!!.use {
                            it.write(Base64.decode(pending.second, Base64.DEFAULT))
                        }
                        pendingExport = null
                        resolve(pendingExportId, true, JSONObject().put("name", displayName(uri)))
                        pendingExportId = -1
                    }
                }
            } catch (e: Exception) {
                error(if (requestCode == REQ_IMPORT) pendingImportId else pendingExportId,
                    e.message ?: "File operation failed")
            }
        }
    }

    private fun displayName(uri: Uri): String {
        return try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && c.moveToFirst()) c.getString(idx) else "file"
            } ?: "file"
        } catch (e: Exception) { "file" }
    }

    private fun mimeFor(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html"
        "js", "mjs" -> "application/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "svg" -> "image/svg+xml"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "ttf" -> "font/ttf"
        "wasm" -> "application/wasm"
        "txt", "md" -> "text/plain"
        "pdf" -> "application/pdf"
        "mp3" -> "audio/mpeg"
        "mp4" -> "video/mp4"
        else -> "application/octet-stream"
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        workers.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }
}
