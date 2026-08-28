/**
 * sendSosNotification — sends an FCM push notification to a RAKSHA user.
 *
 * Called from onSOSSessionUpdate when a trusted contact has a linked
 * RAKSHA account (contactRakshaUid is set) and has an FCM token stored
 * on their user document.
 *
 * In emulator mode (FUNCTIONS_EMULATOR=true) the actual send is skipped
 * and the notification payload is logged — no real FCM credentials needed.
 */
import type { Firestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import * as functions from "firebase-functions";

export async function sendSosNotificationToContact(
  contactUid: string,
  victimName: string,
  triggeredAt: Date,
  db: Firestore,
  logger: typeof functions.logger
): Promise<void> {
  // Fetch the contact's FCM token from their user document
  const userSnap = await db.collection("users").doc(contactUid).get();
  if (!userSnap.exists) {
    logger.warn(`[sendSosNotification] No user doc for contact ${contactUid}`);
    return;
  }

  const fcmToken = userSnap.data()?.["fcmToken"] as string | undefined;
  if (!fcmToken) {
    logger.info(`[sendSosNotification] Contact ${contactUid} has no FCM token — not yet registered`);
    return;
  }

  const timeStr = triggeredAt.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

  const message = {
    token: fcmToken,
    notification: {
      title: "🚨 RAKSHA Emergency Alert",
      body: `${victimName} has triggered an SOS at ${timeStr}. Please check on them immediately.`,
    },
    data: {
      type: "sos_alert",
      triggeredAt: triggeredAt.toISOString(),
    },
    android: {
      priority: "high" as const,
      notification: {
        channelId: "sos_alerts",
        priority: "high" as const,
        defaultSound: true,
        defaultVibrateTimings: true,
      },
    },
  };

  // Skip real FCM send in emulator — just log
  if (process.env["FUNCTIONS_EMULATOR"] === "true") {
    logger.info(`[sendSosNotification] EMULATOR: Would send FCM to ${contactUid}`, {
      title: message.notification.title,
      body:  message.notification.body,
    });
    return;
  }

  try {
    const response = await getMessaging().send(message);
    logger.info(`[sendSosNotification] Sent to ${contactUid}: ${response}`);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "messaging/registration-token-not-registered") {
      // Token is stale — clear it so we don't try again
      logger.warn(`[sendSosNotification] Stale FCM token for ${contactUid} — clearing`);
      await db.collection("users").doc(contactUid).update({ fcmToken: null });
    } else {
      logger.error(`[sendSosNotification] Failed for ${contactUid}:`, err);
    }
  }
}
