/**
 * useGeolocation — requests the device's current position and returns a
 * HashedLocation (SHA-256 hashed coords + raw GeoPoint for proximity matching).
 *
 * Per design.md §6.1 and requirements §3.3:
 * - Coordinates are truncated to 3 decimal places before hashing (≈ 110 m grid).
 * - Raw coords go only into `HashedLocation.current` for the `createSOSSession`
 *   payload. They are never stored in component state or localStorage.
 * - On permission denial or 5-second timeout, returns { location: null }.
 */

export interface GeoPoint { latitude: number; longitude: number }

export interface HashedLocation {
  latHash: string
  lngHash: string
  current?: GeoPoint
}

/** Truncates a coord value to 3 decimal places (matches backend HashedLocation spec). */
function truncate3dp(v: number): number {
  return Math.trunc(v * 1000) / 1000
}

/** Computes a lowercase hex SHA-256 digest of a string using Web Crypto API. */
async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Requests the current position with a longer timeout for cold GPS fixes
 * on Capacitor/Android. Falls back gracefully on denial or timeout.
 */
export async function getCurrentHashedLocation(): Promise<HashedLocation | null> {
  if (!navigator.geolocation) return null

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        const tLat = truncate3dp(lat)
        const tLng = truncate3dp(lng)
        const [latHash, lngHash] = await Promise.all([
          sha256hex(String(tLat)),
          sha256hex(String(tLng)),
        ])
        resolve({ latHash, lngHash, current: { latitude: lat, longitude: lng } })
      },
      () => resolve(null),
      // 15s timeout — Capacitor cold GPS fix can take 8-12s on first use.
      // maximumAge: 30s accepts a recent cached fix (avoids cold-start wait).
      { timeout: 15_000, maximumAge: 30_000, enableHighAccuracy: true },
    )
  })
}
