// AES-CTR cookie payload decryption — counterpart to the server's utils/crypt.js.
//
// The server uses aes-js (CTR mode, hex-encoded ciphertext, no IV — the
// counter starts at zero and the key IS the per-session secret cookie). For
// the first demo we run with `userDataEncryption: false` server-side, in which
// case the secret is empty and payloads pass through verbatim.
//
// When we flip encryption on, port this to the browser-native Web Crypto API:
//   crypto.subtle.encrypt(
//     { name: "AES-CTR", counter: zeros, length: 64 },
//     key,
//     data,
//   )
// `aes-js` itself runs in browsers but adds ~30 kB to the bundle; Web Crypto
// is free of cost and ships with every modern browser.

export function maybeDecryptCookiePayload(payload: string, secret: string): string {
    if (secret === "") return payload;
    // TODO: AES-CTR decrypt via Web Crypto. The secret-delivery path isn't
    // wired up yet either, so this branch is unreachable in dev today.
    throw new Error("encrypted cookie payloads not yet supported in client");
}
