package com.qwen.mobileshell

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CombinedNativeAcceptanceDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun await(message: String, predicate: () -> Boolean) {
        val until = SystemClock.uptimeMillis() + 20000
        while (!predicate()) { assertTrue(message, SystemClock.uptimeMillis() < until); SystemClock.sleep(100) }
    }
    private fun evaluate(view: WebView, script: String): String {
        val done = CountDownLatch(1); var value = ""
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { value = it; done.countDown() } }
        assertTrue("JavaScript timed out", done.await(10, TimeUnit.SECONDS)); return value
    }
    private fun nodes(): List<AccessibilityNodeInfo> {
        fun flatten(node: AccessibilityNodeInfo): List<AccessibilityNodeInfo> = listOf(node) + (0 until node.childCount).mapNotNull { node.getChild(it) }.flatMap { flatten(it) }
        return instrumentation.uiAutomation.rootInActiveWindow?.let { flatten(it) } ?: emptyList()
    }
    private fun clickNode(source: AccessibilityNodeInfo) {
        var target: AccessibilityNodeInfo? = source
        while (target != null && !target.isClickable) target = target.parent
        assertNotNull("No clickable ancestor for ${source.text}", target)
        assertTrue(target!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }
    private fun button(label: String, packagePart: String) {
        var target: AccessibilityNodeInfo? = null
        await("Missing UI button $packagePart / $label") {
            target = nodes().firstOrNull { it.packageName?.toString()?.contains(packagePart) == true && it.text?.toString().equals(label, true) }
            target != null
        }
        clickNode(target!!)
    }
    private fun touch(view: WebView, id: String) {
        val rect = JSONArray(evaluate(view, "(()=>{const r=document.getElementById('$id').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,devicePixelRatio]})()"))
        val location = IntArray(2)
        instrumentation.runOnMainSync { view.getLocationOnScreen(location) }
        val x = location[0] + (rect.getDouble(0) * rect.getDouble(2)).toFloat()
        val y = location[1] + (rect.getDouble(1) * rect.getDouble(2)).toFloat()
        val time = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(MotionEvent.obtain(time,time,MotionEvent.ACTION_DOWN,x,y,0))
        instrumentation.sendPointerSync(MotionEvent.obtain(time,time+60,MotionEvent.ACTION_UP,x,y,0))
    }
    private fun screenshot(name: String) {
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(context.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle()
        }
    }
    private fun pickerOpen() = await("DocumentsUI did not open") { nodes().firstOrNull()?.packageName?.toString()?.contains("documentsui") == true }
    private fun pickInput() {
        var roots = false
        await("Synthetic file not visible") {
            val all = nodes()
            if (all.any { it.text?.toString() == "qwen-combined-input.txt" }) true
            else {
                if (!roots) all.firstOrNull { it.contentDescription?.toString() == "Show roots" }?.let { clickNode(it); roots = true }
                else all.firstOrNull { it.text?.toString() == "Downloads" }?.let { clickNode(it) }
                false
            }
        }
        clickNode(nodes().first { it.text?.toString() == "qwen-combined-input.txt" })
    }
    private fun grantAndStop(view: WebView) {
        val granted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        touch(view,"mic")
        button("Enable microphone","com.qwen.mobileshell")
        if (!granted) button("While using the app","permissioncontroller")
        await("Real audio track was not granted") { evaluate(view,"window.micState") == "\"live\"" }
        touch(view,"stop")
        await("Stop touch did not end the real audio track") { evaluate(view,"window.stream.getAudioTracks()[0].readyState") == "\"ended\"" }
        println("COMBINED_MIC: real getUserMedia audio track granted, explicitly stopped, state ended")
    }
    @Test fun textOnlyOpenAndSavePreserveConnectionAndBytes() = connected { activity, view, _ ->
        touch(view,"open"); pickerOpen(); pickInput()
        await("HTML did not receive file bytes") { evaluate(view,"window.inputResult") != "null" }
        assertEquals("\"SYNTHETIC COMBINED INPUT\\n\"",evaluate(view,"window.inputResult"))
        println("COMBINED_OPEN: real DocumentsUI returned exact synthetic file bytes")
        touch(view,"save"); pickerOpen(); screenshot("combined-text-save.png"); button("Save","documentsui")
        await("Native download did not report saved") { evaluate(view,"window.saveState") == "\"saved\"" }
        instrumentation.runOnMainSync { assertSame(view,views(activity.window.decorView).filterIsInstance<WebView>().single()) }
        println("COMBINED_SAVE: real DocumentsUI completed save; connection remained the same WebView")
    }
    @Test fun stoppedMicThenOpenClosesConnection() = connected { activity, view, _ ->
        grantAndStop(view); touch(view,"open"); pickerOpen(); screenshot("combined-mic-open.png")
        await("Authorized WebView was not closed on opening DocumentsUI") {
            var absent = false
            instrumentation.runOnMainSync { absent = views(activity.window.decorView).filterIsInstance<WebView>().isEmpty() }
            absent
        }
        pickInput()
        await("Reconnect UI did not appear") { nodes().any { it.text?.toString().equals(context.getString(R.string.retry),true) } }
        screenshot("combined-mic-open-reconnect.png")
        println("COMBINED_OPEN_AFTER_MIC: even stopped audio causes connection close when DocumentsUI opens; returned selection cannot reach destroyed HTML; manual reconnect shown")
    }
    @Test fun stoppedMicThenSaveCancelsTransfer() = connected { activity, view, _ ->
        grantAndStop(view); touch(view,"save"); pickerOpen(); screenshot("combined-mic-save.png")
        await("Authorized WebView was not closed on Save picker") {
            var absent = false
            instrumentation.runOnMainSync { absent = views(activity.window.decorView).filterIsInstance<WebView>().isEmpty() }
            absent
        }
        button("Save","documentsui")
        await("Reconnect UI did not appear") { nodes().any { it.text?.toString().equals(context.getString(R.string.retry),true) } }
        screenshot("combined-mic-save-reconnect.png")
        println("COMBINED_SAVE_AFTER_MIC: DocumentsUI destination confirmed after WebView close; original transfer cancelled; manual reconnect shown")
    }
    @Test fun microphoneSnapshotBeforeStopRestoresOnlyAfterExplicitRetry() = connected { originalActivity, originalView, scenario ->
        val route="/session/combined-mic-session?workspace=combined-mic-workspace&context=live"
        evaluate(originalView,"history.replaceState({},'', '$route')")
        grantAndStop(originalView)
        val saved=android.os.Bundle()
        instrumentation.runOnMainSync {
            assertEquals(androidx.lifecycle.Lifecycle.State.RESUMED,originalActivity.lifecycle.currentState)
            instrumentation.callActivityOnSaveInstanceState(originalActivity,saved)
        }
        val snapshot=saved.getBundle("connection-recovery")
        assertNotNull("Connected microphone state needs a recovery snapshot",snapshot)
        assertTrue("Saving before onStop must retain explicit Retry requirement",snapshot!!.getBoolean("retry"))
        assertEquals("combined-mic-session",snapshot.getString("session"))
        assertEquals("combined-mic-workspace",snapshot.getString("workspace"))
        println("COMBINED_RECOVERY_SNAPSHOT: saved while RESUMED before onStop; retry=true; scoped session/workspace retained")
        scenario.recreate()
        lateinit var recreated:MainActivity
        scenario.onActivity { recreated=it }
        SystemClock.sleep(300)
        instrumentation.runOnMainSync { assertTrue("Microphone-authorized recovery must not reopen a WebView automatically",views(recreated.window.decorView).filterIsInstance<WebView>().isEmpty()) }
        button("Retry","com.qwen.mobileshell")
        var restored:WebView?=null
        await("Explicit Retry did not create a WebView") { instrumentation.runOnMainSync { restored=views(recreated.window.decorView).filterIsInstance<WebView>().singleOrNull() };restored!=null }
        await("Retry did not load the fixture") { evaluate(restored!!,"window.combinedReady===true")=="true" }
        assertEquals("\"$route\"",evaluate(restored!!,"location.pathname+location.search"))
        assertNotSame(originalView,restored)
        assertEquals("null",evaluate(restored!!,"window.stream"))
        assertEquals("\"idle\"",evaluate(restored!!,"window.micState"))
        touch(restored!!,"mic")
        await("Restored connection bypassed fresh native microphone consent") { nodes().any { it.packageName?.toString()=="com.qwen.mobileshell" && it.text?.toString().equals("Enable microphone",true) } }
        assertEquals("null",evaluate(restored!!,"window.stream"))
        assertEquals("\"idle\"",evaluate(restored!!,"window.micState"))
        button("Cancel","com.qwen.mobileshell")
        await("Native denial did not complete the request") { evaluate(restored!!,"window.micState")=="\"NotAllowedError\"" }
        assertEquals("null",evaluate(restored!!,"window.stream"))
        println("COMBINED_RECOVERY: actual Activity recreation stayed on Retry; explicit Retry restored same route; no capture auto-started; fresh native consent required despite OS grant")
    }
    private fun connected(body: (MainActivity,WebView,ActivityScenario<MainActivity>)->Unit) {
        assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) && WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA))
        instrumentation.uiAutomation.serviceInfo = instrumentation.uiAutomation.serviceInfo.apply { flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS }
        val outputName = "qwen-combined-save-${UUID.randomUUID()}.txt"
        println("COMBINED_DESTINATION: $outputName")
        val page = """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px sans-serif}button,input{display:block;height:52px;width:280px;margin:12px}</style>
            <button id="mic">Start microphone</button><button id="stop">Stop microphone</button><input type="file" id="open" accept="text/plain"><button id="save">Save synthetic text</button>
            <script>
            window.jsErrors=[];window.onerror=(m)=>window.jsErrors.push(String(m));window.inputResult=null;window.micState='idle';window.saveState='idle';window.stream=null;
            mic.onclick=async()=>{try{window.stream=await navigator.mediaDevices.getUserMedia({audio:true});window.micState=stream.getAudioTracks()[0].readyState}catch(e){window.micState=e.name}};
            document.getElementById('stop').onclick=()=>{stream.getTracks().forEach(t=>t.stop());window.micState='ended'};
            document.getElementById('open').onchange=async e=>{window.inputResult=await e.target.files[0].text()};
            const bridge=window.qwenAndroidDownloadV1;
            const id='1234567890abcdef1234567890abcdef';
            const bytes=new TextEncoder().encode('SYNTHETIC COMBINED OUTPUT\n');const frame=new Uint8Array(36+bytes.length);frame.set(new TextEncoder().encode(id),0);new DataView(frame.buffer).setUint32(32,0,false);frame.set(bytes,36);
            bridge.onmessage=event=>{const message=JSON.parse(event.data);window.saveMessage=message;window.saveState=message.state;if(message.state==='ready')bridge.postMessage(frame.buffer);if(message.state==='chunk')bridge.postMessage(JSON.stringify({v:1,id,op:'finish'}))};
            document.getElementById('save').onclick=()=>bridge.postMessage(JSON.stringify({v:1,id,op:'begin',name:'$outputName',mime:'text/plain',size:bytes.length}));
            window.combinedReady=true;
            </script>
        """.trimIndent().toByteArray()
        val server = ServerSocket(0,8,InetAddress.getByName("127.0.0.1"))
        val worker = Thread {
            try { while (!server.isClosed) server.accept().use { socket ->
                socket.soTimeout=3000;val reader=socket.getInputStream().bufferedReader();reader.readLine();while (!reader.readLine().isNullOrEmpty()) {}
                socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${page.size}\r\nConnection: close\r\n\r\n".toByteArray());write(page);flush() }
            } } catch (_:Exception) {}
        }.apply { isDaemon=true;start() }
        val store=AndroidProfileStore(context)
        val profile=ConnectionProfile.create("Combined test ${UUID.randomUUID()}","http://127.0.0.1:${server.localPort}/",null)
        store.vault.upsert(store.vault.load(),profile)
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                lateinit var activity:MainActivity
                scenario.onActivity { activity=it;val all=views(it.window.decorView);val title=all.indexOfFirst { it is TextView && it.text.toString()==profile.name };assertTrue(title>=0);all.drop(title+1).filterIsInstance<Button>().first { it.text.toString().equals(context.getString(R.string.connect),true) }.performClick() }
                var view:WebView?=null
                await("Connection did not create WebView") { instrumentation.runOnMainSync { view=views(activity.window.decorView).filterIsInstance<WebView>().singleOrNull() };view!=null }
                await("Combined HTML fixture did not load") { evaluate(view!!,"window.combinedReady===true")=="true" }
                body(activity,view!!,scenario)
            }
        } finally {
            val state=store.vault.load();state.profiles.find { it.id==profile.id }?.let { store.vault.remove(state,it) };server.close();worker.join(4000)
        }
    }
}
