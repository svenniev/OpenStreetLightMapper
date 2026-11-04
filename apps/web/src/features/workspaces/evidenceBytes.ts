/**
 * Byte helpers for evidence hashing. These run in browsers, so they must not
 * touch Node-only globals (Buffer); vitest runs on Node where Buffer exists,
 * which is exactly how the browser crash slipped through.
 */
export async function sha256HexAsync(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
