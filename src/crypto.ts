export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSecret(prefix: "tpk"): string {
  const b64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  return `${prefix}_${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
