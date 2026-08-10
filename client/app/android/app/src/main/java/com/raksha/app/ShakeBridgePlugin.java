package com.raksha.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin that exposes startShakeDetector() and stopShakeDetector()
 * to the JS layer, allowing the app to start/stop the shake Foreground Service
 * when the user enables or disables the shake trigger in Setup Screen.
 *
 * JS usage:
 *   import { registerPlugin } from '@capacitor/core';
 *   const ShakeBridge = registerPlugin('ShakeBridge');
 *   await ShakeBridge.startShakeDetector();
 *   await ShakeBridge.stopShakeDetector();
 */
@CapacitorPlugin(name = "ShakeBridge")
public class ShakeBridgePlugin extends Plugin {

    @PluginMethod
    public void startShakeDetector(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) {
            // Read optional sensitivity param (1=light, 2=medium, 3=strong); default 2
            int sensitivity = call.getInt("sensitivity", 2);
            sensitivity = Math.max(1, Math.min(3, sensitivity));
            activity.startShakeService(sensitivity);
            android.util.Log.d("RAKSHA", "ShakeBridgePlugin.startShakeDetector() sensitivity=" + sensitivity);
            call.resolve();
        } else {
            call.reject("Activity not available");
        }
    }

    @PluginMethod
    public void stopShakeDetector(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) {
            activity.stopShakeService();
            android.util.Log.d("RAKSHA", "ShakeBridgePlugin.stopShakeDetector() called from JS");
            call.resolve();
        } else {
            call.reject("Activity not available");
        }
    }
}
