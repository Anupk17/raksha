/**
 * useFCMToken — registers the device for FCM push notifications and
 * stores the token on the user's Firestore document.
 *
 * Called once on app mount (inside AuthProvider or App.tsx) after auth
 * resolves. On Android, requests notification permission via the
 * Capacitor PushNotifications plugin, then stores the token at
 * /users/{uid}.fcmToken for the backend to use when sending SOS alerts.
 *
 * In emulator mode the token is logged but not sent to a real FCM server.
 */
import { useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { doc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import type { User } from 'firebase/auth'

export function useFCMToken(user: User | null) {
  useEffect(() => {
    if (!user) return
    if (!Capacitor.isNativePlatform()) return  // FCM only on native device

    const uid = user.uid

    async function register() {
      try {
        // Request permission
        const permResult = await PushNotifications.requestPermissions()
        if (permResult.receive !== 'granted') {
          console.log('[FCM] Notification permission denied')
          return
        }

        // Register with FCM
        await PushNotifications.register()

        // Listen for the token
        PushNotifications.addListener('registration', async (token) => {
          console.log('[FCM] Token received:', token.value.slice(0, 20) + '...')
          try {
            await setDoc(
              doc(db, 'users', uid),
              { fcmToken: token.value, fcmTokenUpdatedAt: new Date() },
              { merge: true }
            )
            console.log('[FCM] Token stored in Firestore')
          } catch (err) {
            console.error('[FCM] Failed to store token:', err)
          }
        })

        // Listen for push notification received while app is open
        PushNotifications.addListener('pushNotificationReceived', (notification) => {
          console.log('[FCM] Push received:', notification.title)
          // Could show an in-app banner here — for now just log
        })

        // Listen for push notification tapped (app was in background)
        PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          console.log('[FCM] Push tapped:', action.notification.title)
          // Could navigate to a specific screen here
        })

      } catch (err) {
        console.error('[FCM] Registration failed:', err)
      }
    }

    void register()

    return () => {
      void PushNotifications.removeAllListeners()
    }
  }, [user?.uid]) // eslint-disable-line react-hooks/exhaustive-deps
}
