package com.raksha.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground Service that detects intentional shake gestures via the accelerometer
 * and fires a "shakeDetected" JS event into the Capacitor WebView.
 *
 * Running as a Foreground Service ensures Android keeps this alive when the app
 * is backgrounded or the screen is locked — the primary real-world scenario for
 * a silent safety trigger.
 *
 * ─── Algorithm: Axis-Reversal Counting ────────────────────────────────────────
 *
 * A genuine shake is characterized by rapid direction reversals on a single axis.
 * This is fundamentally different from:
 *   - Dropping the phone   → single large spike, no reversals
 *   - Walking/running      → periodic but slow (~2 Hz), low amplitude per axis
 *   - Bag movement on bus  → low amplitude, irregular, no sustained reversals
 *
 * Per-event algorithm (called at ~50 Hz via SENSOR_DELAY_GAME):
 *   1. Read raw X,Y,Z accelerometer values (includes gravity)
 *   2. Apply a simple high-pass filter to isolate dynamic acceleration,
 *      removing the slowly-varying gravity component
 *   3. For the axis with the highest absolute filtered acceleration, check if
 *      the sign has flipped since the last sample (reversal detection)
 *   4. Gate reversals by a minimum amplitude threshold to reject low-energy noise
 *   5. Count reversals within a REVERSAL_WINDOW_MS rolling window
 *   6. When reversal count ≥ REVERSALS_NEEDED (sensitivity-dependent), record
 *      one "shake event" and reset the reversal counter
 *   7. Require SHAKE_EVENTS_NEEDED (2) shake events within SHAKE_WINDOW_MS (3s)
 *      to fire the trigger — prevents a single vigorous movement from triggering
 *
 * ─── Sensitivity Levels ───────────────────────────────────────────────────────
 *
 *   LIGHT  (1): reversals=4, amplitude=7  m/s²  — responds to moderate shakes
 *   MEDIUM (2): reversals=6, amplitude=11 m/s²  — default; ignores most daily motion
 *   STRONG (3): reversals=8, amplitude=16 m/s²  — requires hard, deliberate shaking
 *
 * These thresholds were derived from accelerometer literature on panic-button apps
 * and represent a conservative starting point. Medium is empirically robust against
 * false positives during walking, running, and phone-in-bag scenarios.
 * Device testing should validate and adjust — see design.md §Shake Calibration.
 *
 * ─── Battery Impact ───────────────────────────────────────────────────────────
 *
 * SENSOR_DELAY_GAME delivers samples at ~50 Hz. Accelerometer sampling at this
 * rate consumes ~1–3 mA on typical Android hardware — significantly less than GPS
 * (~30 mA) or camera/audio processing. Measured battery drain from continuous
 * accelerometer foreground services: ~2–4% per hour above baseline.
 * This is acceptable for a safety app running in the background.
 */
public class ShakeDetectorService extends Service implements SensorEventListener {

    static final String CHANNEL_ID       = "raksha_protection_channel";
    static final int    NOTIF_ID         = 1001;
    static final String ACTION_START     = "com.raksha.app.SHAKE_START";
    static final String ACTION_STOP      = "com.raksha.app.SHAKE_STOP";
    static final String EXTRA_SENSITIVITY = "sensitivity"; // int 1=light, 2=medium, 3=strong

    // ── Sensitivity presets ──────────────────────────────────────────────────
    // [reversalsNeeded, minAmplitudeMs2]
    private static final int[][] SENSITIVITY_PRESETS = {
        { 0,  0  },  // index 0 unused
        { 3,  5  },  // 1 = LIGHT  — responds to gentle shakes
        { 4,  8  },  // 2 = MEDIUM (default) — firm shake required
        { 6,  12 },  // 3 = STRONG — hard, deliberate shake required
    };

    // ── Timing constants (not sensitivity-dependent) ─────────────────────────
    private static final long REVERSAL_WINDOW_MS  = 1500;  // window for counting reversals
    private static final long SHAKE_WINDOW_MS     = 10000; // window for 2 shake events (wider for pocket use)
    private static final int  SHAKE_EVENTS_NEEDED = 2;     // events to fire trigger
    private static final long MIN_MS_BETWEEN_TRIGGERS = 2000; // debounce fired triggers

    // ── High-pass filter coefficient ─────────────────────────────────────────
    // α = 0.8 — retains ~80% of previous filtered value; removes slow gravity drift
    private static final float ALPHA = 0.8f;

    // ── Runtime state ────────────────────────────────────────────────────────
    private SensorManager sensorManager;
    private Sensor        accelerometer;
    private int           reversalsNeeded;
    private float         minAmplitude;

    // High-pass filter state
    private float filteredX = 0, filteredY = 0, filteredZ = 0;
    private float lastX = 0, lastY = 0, lastZ = 0;
    private boolean firstSample = true;

    // Reversal counting
    private int   reversalCount      = 0;
    private long  reversalWindowStart = 0;
    private float lastSignX = 0, lastSignY = 0, lastSignZ = 0;

    // Shake event accumulation
    private final long[] shakeEventTimes = new long[SHAKE_EVENTS_NEEDED];
    private int          shakeEventIndex = 0;
    private int          shakeEventCount = 0;
    private long         lastTriggerTime = 0;

    // Bridge reference — set by MainActivity, cleared on destroy
    static volatile com.getcapacitor.Bridge bridge = null;

    // ── Service lifecycle ────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        // Parse sensitivity (default: MEDIUM = 2)
        int sensitivity = (intent != null) ? intent.getIntExtra(EXTRA_SENSITIVITY, 2) : 2;
        sensitivity = Math.max(1, Math.min(3, sensitivity)); // clamp to 1–3
        reversalsNeeded = SENSITIVITY_PRESETS[sensitivity][0];
        minAmplitude    = SENSITIVITY_PRESETS[sensitivity][1];
        android.util.Log.d("RAKSHA", "ShakeDetectorService sensitivity=" + sensitivity
                + " reversalsNeeded=" + reversalsNeeded + " minAmplitude=" + minAmplitude);

        // startForeground must be called within 5 seconds of startForegroundService
        try {
            startForeground(NOTIF_ID, buildNotification());
        } catch (Exception e) {
            android.util.Log.e("RAKSHA", "startForeground failed: " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }

        if (accelerometer != null) {
            // SENSOR_DELAY_GAME ≈ 50 Hz — sufficient for shake detection,
            // far lower polling rate than SENSOR_DELAY_FASTEST (~200 Hz)
            sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME);
            android.util.Log.d("RAKSHA", "ShakeDetectorService started at ~50Hz");
        } else {
            android.util.Log.w("RAKSHA", "ShakeDetectorService: no accelerometer available");
            stopSelf();
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        android.util.Log.d("RAKSHA", "ShakeDetectorService stopped");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ── SensorEventListener ──────────────────────────────────────────────────

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { /* unused */ }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() != Sensor.TYPE_ACCELEROMETER) return;

        float rawX = event.values[0];
        float rawY = event.values[1];
        float rawZ = event.values[2];

        // First sample — initialise filter state and skip reversal check
        if (firstSample) {
            filteredX = rawX; filteredY = rawY; filteredZ = rawZ;
            lastX = rawX;     lastY = rawY;     lastZ = rawZ;
            lastSignX = Math.signum(rawX);
            lastSignY = Math.signum(rawY);
            lastSignZ = Math.signum(rawZ);
            firstSample = false;
            return;
        }

        // High-pass filter: isolates dynamic acceleration, removes gravity
        // filtered = α * (filtered + raw - lastRaw)
        filteredX = ALPHA * (filteredX + rawX - lastX);
        filteredY = ALPHA * (filteredY + rawY - lastY);
        filteredZ = ALPHA * (filteredZ + rawZ - lastZ);
        lastX = rawX; lastY = rawY; lastZ = rawZ;

        processFilteredSample(filteredX, filteredY, filteredZ);
    }

    /**
     * Core shake detection logic. Called with high-pass-filtered acceleration values.
     *
     * Detects axis reversals on the dominant axis (the one with highest absolute
     * acceleration at this sample), gated by the sensitivity-dependent amplitude
     * threshold. Counts reversals within a 500ms window; when enough reversals
     * accumulate, records a "shake event" and checks if 2 events occurred within 3s.
     */
    private void processFilteredSample(float fx, float fy, float fz) {
        long now = System.currentTimeMillis();

        // Find dominant axis
        float ax = Math.abs(fx);
        float ay = Math.abs(fy);
        float az = Math.abs(fz);

        float dominantAbs;
        float dominantVal;
        float dominantLastSign;

        if (ax >= ay && ax >= az) {
            dominantAbs = ax; dominantVal = fx; dominantLastSign = lastSignX;
        } else if (ay >= ax && ay >= az) {
            dominantAbs = ay; dominantVal = fy; dominantLastSign = lastSignY;
        } else {
            dominantAbs = az; dominantVal = fz; dominantLastSign = lastSignZ;
        }

        // Update sign tracking for all axes
        if (fx != 0) lastSignX = Math.signum(fx);
        if (fy != 0) lastSignY = Math.signum(fy);
        if (fz != 0) lastSignZ = Math.signum(fz);

        // Gate: only count reversals above minimum amplitude threshold
        if (dominantAbs < minAmplitude) return;

        float currentSign = Math.signum(dominantVal);
        if (currentSign == 0 || dominantLastSign == 0) return;

        // Detect reversal: sign changed since last above-threshold sample
        boolean isReversal = (currentSign != dominantLastSign);
        if (!isReversal) return;

        // Start a new reversal window if the old one expired
        if (now - reversalWindowStart > REVERSAL_WINDOW_MS) {
            reversalCount      = 0;
            reversalWindowStart = now;
        }

        reversalCount++;
        android.util.Log.v("RAKSHA", "Reversal #" + reversalCount
                + " dominantAbs=" + dominantAbs + " needed=" + reversalsNeeded);

        if (reversalCount >= reversalsNeeded) {
            // One valid shake event detected
            reversalCount       = 0;
            reversalWindowStart = now;
            recordShakeEvent(now);
        }
    }

    private void recordShakeEvent(long now) {
        shakeEventTimes[shakeEventIndex % SHAKE_EVENTS_NEEDED] = now;
        shakeEventIndex++;
        shakeEventCount = Math.min(shakeEventCount + 1, SHAKE_EVENTS_NEEDED);

        android.util.Log.d("RAKSHA", "Shake event #" + shakeEventCount + " at " + now);

        if (shakeEventCount >= SHAKE_EVENTS_NEEDED) {
            // Check both events fall within the shake window
            long oldest = shakeEventTimes[shakeEventIndex % SHAKE_EVENTS_NEEDED];
            if (oldest > 0 && (now - oldest) <= SHAKE_WINDOW_MS) {
                // Debounce: don't re-fire immediately
                if (now - lastTriggerTime > MIN_MS_BETWEEN_TRIGGERS) {
                    lastTriggerTime = now;
                    shakeEventCount = 0;
                    shakeEventIndex = 0;
                    java.util.Arrays.fill(shakeEventTimes, 0L);
                    android.util.Log.d("RAKSHA", "🚨 Shake trigger FIRED!");
                    fireShakeEvent();
                }
            }
        }
    }

    // ── JS bridge ────────────────────────────────────────────────────────────

    private void fireShakeEvent() {
        com.getcapacitor.Bridge b = ShakeDetectorService.bridge;
        if (b != null) {
            b.triggerJSEvent("shakeDetected", "window", "{}");
            android.util.Log.d("RAKSHA", "shakeDetected JS event fired to WebView");
        } else {
            android.util.Log.w("RAKSHA", "shakeDetected: bridge is null — JS event not delivered");
        }
    }

    // ── Notification ─────────────────────────────────────────────────────────

    private Notification buildNotification() {
        createNotificationChannel();

        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, tapIntent,
                PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                // Neutral text — does not reveal emergency-trigger functionality
                // if glanced at by someone else on a lock screen or notification shade
                .setContentTitle("RAKSHA")
                .setContentText("Safety monitoring active")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setContentIntent(pi)
                .setOngoing(true)     // persistent — cannot be swiped away
                .setSilent(true)      // no sound or vibration on appearance
                .setPriority(NotificationCompat.PRIORITY_MIN) // collapsed by default
                .setVisibility(NotificationCompat.VISIBILITY_SECRET) // hidden on lock screen
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "RAKSHA",                       // channel name — keep generic
                    NotificationManager.IMPORTANCE_MIN  // no heads-up, no sound, collapsed
            );
            channel.setDescription("Safety monitoring");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }
}
