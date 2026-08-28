package com.raksha.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.view.KeyEvent;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;

/**
 * MainActivity — Capacitor host activity.
 *
 * Responsibilities:
 *  1. Earbud hardware button detection via MediaSessionCompat (foreground only).
 *  2. Shake detection via ShakeDetectorService (Foreground Service — works
 *     while app is backgrounded or screen is locked).
 *  3. Exposes startShakeDetector() / stopShakeDetector() callable from JS via
 *     a Capacitor plugin bridge, so the JS layer can start/stop the service
 *     when the user enables/disables shake trigger in Setup Screen.
 *
 * JS API (called via Capacitor.Plugins.ShakeBridge):
 *   startShakeDetector()  — starts the foreground service
 *   stopShakeDetector()   — stops the foreground service
 *
 * Events fired to JS:
 *   window "earbudClick"   — earbud button pressed (keyCode in detail)
 *   window "shakeDetected" — shake trigger fired by ShakeDetectorService
 */
public class MainActivity extends BridgeActivity {

    private static final int REQUEST_NOTIFICATIONS = 1001;
    private MediaSessionCompat mediaSession;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register ShakeBridgePlugin BEFORE super.onCreate so Capacitor picks it up
        registerPlugin(ShakeBridgePlugin.class);
        registerPlugin(PdfOpenerPlugin.class);
        super.onCreate(savedInstanceState);

        // Set static bridge reference so ShakeDetectorService can fire JS events
        ShakeDetectorService.bridge = getBridge();

        initMediaSession();
        requestNotificationPermissionIfNeeded();
        createSosNotificationChannel();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        ShakeDetectorService.bridge = null;
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        // Stop the shake service when the activity is fully destroyed
        stopShakeService();
    }

    // -------------------------------------------------------------------------
    // Shake service control (called by ShakeBridgePlugin)
    // -------------------------------------------------------------------------

    void startShakeService(int sensitivity) {
        ShakeDetectorService.bridge = getBridge();
        Intent intent = new Intent(this, ShakeDetectorService.class);
        intent.setAction(ShakeDetectorService.ACTION_START);
        intent.putExtra(ShakeDetectorService.EXTRA_SENSITIVITY, sensitivity);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
        android.util.Log.d("RAKSHA", "startShakeService() sensitivity=" + sensitivity);
    }

    void stopShakeService() {
        Intent intent = new Intent(this, ShakeDetectorService.class);
        intent.setAction(ShakeDetectorService.ACTION_STOP);
        startService(intent);
        android.util.Log.d("RAKSHA", "stopShakeService() called");
    }

    // -------------------------------------------------------------------------
    // Notification permission (Android 13+)
    // -------------------------------------------------------------------------

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this,
                    Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQUEST_NOTIFICATIONS);
            }
        }
    }

    /** Create the high-priority notification channel used for SOS alerts. */
    private void createSosNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                "sos_alerts",
                "RAKSHA SOS Alerts",
                android.app.NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Emergency SOS notifications from people you protect");
            channel.enableVibration(true);
            channel.enableLights(true);
            android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    // -------------------------------------------------------------------------
    // Earbud — MediaSessionCompat (foreground only, best-effort)
    // -------------------------------------------------------------------------

    private void initMediaSession() {
        mediaSession = new MediaSessionCompat(this, "RakshaEarbudSession");
        mediaSession.setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        PlaybackStateCompat state = new PlaybackStateCompat.Builder()
                .setActions(
                        PlaybackStateCompat.ACTION_PLAY |
                        PlaybackStateCompat.ACTION_PAUSE |
                        PlaybackStateCompat.ACTION_PLAY_PAUSE |
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                )
                .setState(PlaybackStateCompat.STATE_PLAYING, 0, 1.0f)
                .build();
        mediaSession.setPlaybackState(state);

        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                KeyEvent event = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (event == null) return false;
                if (event.getAction() != KeyEvent.ACTION_DOWN) return false;
                int code = event.getKeyCode();
                android.util.Log.d("RAKSHA", "MediaSession button event: keyCode=" + code);
                if (code == KeyEvent.KEYCODE_HEADSETHOOK
                        || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                        || code == KeyEvent.KEYCODE_MEDIA_PREVIOUS
                        || code == KeyEvent.KEYCODE_MEDIA_NEXT) {
                    android.util.Log.d("RAKSHA", "Firing earbudClick JS event for keyCode=" + code);
                    getBridge().triggerJSEvent("earbudClick", "window",
                            "{\"keyCode\":" + code + "}");
                    return true;
                }
                return false;
            }
        });
        mediaSession.setActive(true);
        android.util.Log.d("RAKSHA", "MediaSessionCompat active");
    }
}
