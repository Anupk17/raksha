/**
 * lookupUserByEmail — HTTPS callable Cloud Function.
 *
 * Takes an email address and returns the Firebase Auth UID of the user
 * with that email, if they exist. Used by the client to link a trusted
 * contact's email to their RAKSHA account UID.
 *
 * Privacy: only returns the UID (not name, email, or any other user data).
 * The caller must be authenticated.
 */
import * as functions from "firebase-functions";
import { getAuth } from "firebase-admin/auth";

export const lookupUserByEmailHandler = functions.https.onCall(
  async (data: { email: string }, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }

    const email = (data.email ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid email address.");
    }

    try {
      const userRecord = await getAuth().getUserByEmail(email);
      return { uid: userRecord.uid, found: true };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/user-not-found") {
        return { uid: null, found: false };
      }
      throw new functions.https.HttpsError("internal", "Could not look up user.");
    }
  }
);
