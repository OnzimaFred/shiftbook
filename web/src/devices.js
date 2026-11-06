// Phone features: camera (QR scanning and photos), location, and fingerprint passkeys.
import jsQR from "jsqr";
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export const supportsPasskeys = () => browserSupportsWebAuthn();

/** Starts the camera into a <video>. facing: "environment" (back) or "user" (front). Returns stop(). */
export async function openCamera(video, facing = "environment") {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the camera. Open Shiftbook in Chrome.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    throw new Error(e?.name === "NotAllowedError"
      ? "Shiftbook needs the camera. Allow camera access in your browser settings, then try again."
      : "The camera couldn't start. Close other apps using it and try again.");
  }
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play().catch(() => {});
  return () => stream.getTracks().forEach((t) => t.stop());
}

/** Watches the camera until a Shiftbook clock-in code is seen. Resolves with its text. */
export function scanForCode(video, isCancelled) {
  const detector = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (isCancelled()) return reject(new Error("cancelled"));
      try {
        if (video.readyState >= 2) {
          let text = null;
          if (detector) {
            const found = await detector.detect(video).catch(() => []);
            text = found.find((f) => f.rawValue?.startsWith("SB1."))?.rawValue ?? null;
          } else {
            const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
            if (w && h) {
              canvas.width = w; canvas.height = h;
              ctx.drawImage(video, 0, 0, w, h);
              const img = ctx.getImageData(0, 0, w, h);
              const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
              if (code?.data?.startsWith("SB1.")) text = code.data;
            }
          }
          if (text) return resolve(text);
        }
      } catch { /* keep trying */ }
      setTimeout(tick, 200);
    };
    tick();
  });
}

/** A still from the camera as a JPEG data URL, small enough to upload quickly. */
export function capturePhoto(video, maxWidth = 480) {
  const w = Math.min(maxWidth, video.videoWidth || maxWidth);
  const h = Math.round((video.videoHeight || w * 4 / 3) * (w / (video.videoWidth || w)));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(video, 0, 0, w, h);
  let q = 0.75, url = c.toDataURL("image/jpeg", q);
  while (url.length > 380_000 && q > 0.35) { q -= 0.1; url = c.toDataURL("image/jpeg", q); }
  return url;
}

/** The phone's position, or null if it isn't shared within 12 seconds. */
export function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 });
  });
}

const friendlyWebAuthn = (e) => {
  if (e?.name === "NotAllowedError") return "The fingerprint check was cancelled or timed out. Try again.";
  if (e?.name === "InvalidStateError") return "This phone is already set up for you.";
  if (e?.name === "NotSupportedError") return "This phone can't use a fingerprint for Shiftbook. Use the control-room phone.";
  return e?.message ?? "The fingerprint check didn't work.";
};

export async function fingerprintRegister(options) {
  try { return await startRegistration(options); } catch (e) { throw new Error(friendlyWebAuthn(e)); }
}
export async function fingerprintCheck(options) {
  try { return await startAuthentication(options); } catch (e) { throw new Error(friendlyWebAuthn(e)); }
}

/** Keeps the screen on (kiosk). Silently does nothing where unsupported. */
export async function keepAwake() {
  try {
    let lock = await navigator.wakeLock?.request("screen");
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") lock = await navigator.wakeLock?.request("screen").catch(() => null);
    });
    return lock;
  } catch { return null; }
}
