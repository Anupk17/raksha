/**
 * firebase.ts — Firebase app singleton + emulator wiring.
 *
 * All three connect*Emulator calls happen synchronously at module load time,
 * before any Auth / Firestore / Functions call is made anywhere in the app.
 */
import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { Capacitor } from '@capacitor/core'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID as string,
}

const app = initializeApp(firebaseConfig)

export const auth    = getAuth(app)
export const db      = getFirestore(app)
export const fns     = getFunctions(app)
export const storage = getStorage(app)

if (import.meta.env.VITE_USE_EMULATOR === 'true') {
  // Host resolution priority:
  //   1. VITE_EMULATOR_HOST if explicitly set (use for real physical devices — set to laptop's WiFi IP)
  //   2. 10.0.2.2 when running on Android emulator (AVD special alias for host localhost)
  //   3. localhost for browser dev
  const explicitHost = import.meta.env.VITE_EMULATOR_HOST as string | undefined
  const fallbackHost = Capacitor.getPlatform() === 'android' ? '10.0.2.2' : 'localhost'
  const host = explicitHost || fallbackHost
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true })
  connectFirestoreEmulator(db, host, 8080)
  connectFunctionsEmulator(fns, host, 5001)
  connectStorageEmulator(storage, host, 9199)
}

