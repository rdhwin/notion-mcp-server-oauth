// workers-oauth-utils.ts
// OAuth utility functions with CSRF and state validation security fixes
// Adapted from Cloudflare's remote-mcp-github-oauth demo

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({ error: this.code, error_description: this.description }),
      { status: this.statusCode, headers: { "Content-Type": "application/json" } },
    );
  }
}

export interface OAuthStateResult {
  stateToken: string;
}

export interface ValidateStateResult {
  oauthReqInfo: AuthRequest;
  clearCookie: string;
}

export interface BindStateResult {
  setCookie: string;
}

export interface CSRFProtectionResult {
  token: string;
  setCookie: string;
}

export interface ValidateCSRFResult {
  clearCookie: string;
}

export function sanitizeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function sanitizeUrl(url: string): string {
  const normalized = url.trim();
  if (normalized.length === 0) return "";

  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) return "";
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalized);
  } catch {
    return "";
  }

  const scheme = parsedUrl.protocol.slice(0, -1).toLowerCase();
  if (!["https", "http"].includes(scheme)) return "";

  return normalized;
}

export function generateCSRFProtection(): CSRFProtectionResult {
  const token = crypto.randomUUID();
  const setCookie = `__Host-CSRF_TOKEN=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
  return { token, setCookie };
}

export function validateCSRFToken(formData: FormData, request: Request): ValidateCSRFResult {
  const csrfCookieName = "__Host-CSRF_TOKEN";
  const tokenFromForm = formData.get("csrf_token");

  if (!tokenFromForm || typeof tokenFromForm !== "string") {
    throw new OAuthError("invalid_request", "Missing CSRF token in form data", 400);
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const csrfCookie = cookies.find((c) => c.startsWith(`${csrfCookieName}=`));
  const tokenFromCookie = csrfCookie ? csrfCookie.substring(csrfCookieName.length + 1) : null;

  if (!tokenFromCookie) throw new OAuthError("invalid_request", "Missing CSRF token cookie", 400);
  if (tokenFromForm !== tokenFromCookie) throw new OAuthError("invalid_request", "CSRF token mismatch", 400);

  return { clearCookie: `${csrfCookieName}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0` };
}

export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  stateTTL = 600,
): Promise<OAuthStateResult> {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), { expirationTtl: stateTTL });
  return { stateToken };
}

export async function bindStateToSession(stateToken: string): Promise<BindStateResult> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(stateToken));
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { setCookie: `__Host-CONSENTED_STATE=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600` };
}

export async function validateOAuthState(request: Request, kv: KVNamespace): Promise<ValidateStateResult> {
  const consentedStateCookieName = "__Host-CONSENTED_STATE";
  const url = new URL(request.url);
  const stateFromQuery = url.searchParams.get("state");

  if (!stateFromQuery) throw new OAuthError("invalid_request", "Missing state parameter", 400);

  const storedDataJson = await kv.get(`oauth:state:${stateFromQuery}`);
  if (!storedDataJson) throw new OAuthError("invalid_request", "Invalid or expired state", 400);

  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const consentedStateCookie = cookies.find((c) => c.startsWith(`${consentedStateCookieName}=`));
  const consentedStateHash = consentedStateCookie
    ? consentedStateCookie.substring(consentedStateCookieName.length + 1)
    : null;

  if (!consentedStateHash) {
    throw new OAuthError("invalid_request", "Missing session binding cookie - authorization flow must be restarted", 400);
  }

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(stateFromQuery));
  const stateHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (stateHash !== consentedStateHash) {
    throw new OAuthError("invalid_request", "State token does not match session - possible CSRF attack detected", 400);
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(storedDataJson) as AuthRequest;
  } catch {
    throw new OAuthError("server_error", "Invalid state data", 500);
  }

  await kv.delete(`oauth:state:${stateFromQuery}`);
  const clearCookie = `${consentedStateCookieName}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

  return { oauthReqInfo, clearCookie };
}

export async function isClientApproved(request: Request, clientId: string, cookieSecret: string): Promise<boolean> {
  const approvedClients = await getApprovedClientsFromCookie(request, cookieSecret);
  return approvedClients?.includes(clientId) ?? false;
}

export async function addApprovedClient(request: Request, clientId: string, cookieSecret: string): Promise<string> {
  const existing = (await getApprovedClientsFromCookie(request, cookieSecret)) || [];
  const updated = Array.from(new Set([...existing, clientId]));
  const payload = JSON.stringify(updated);
  const signature = await signData(payload, cookieSecret);
  return `__Host-APPROVED_CLIENTS=${signature}.${btoa(payload)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000`;
}

export interface ApprovalDialogOptions {
  client: ClientInfo | null;
  server: { name: string; logo?: string; description?: string };
  state: Record<string, unknown>;
  csrfToken: string;
  setCookie: string;
}

export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
  const { client, server, state, csrfToken, setCookie } = options;
  const encodedState = btoa(JSON.stringify(state));
  const serverName = sanitizeText(server.name);
  const clientName = client?.clientName ? sanitizeText(client.clientName) : "Unknown MCP Client";
  const serverDescription = server.description ? sanitizeText(server.description) : "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${clientName} | Authorization Request</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; margin: 0; padding: 2rem 1rem; color: #333; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 8px 36px rgba(0,0,0,0.1); padding: 2rem; }
  h1 { font-size: 1.3rem; font-weight: 500; text-align: center; margin-bottom: 0.5rem; }
  p { color: #555; text-align: center; }
  .alert { font-size: 1.1rem; margin: 1.5rem 0; text-align: center; }
  .actions { display: flex; gap: 1rem; justify-content: flex-end; margin-top: 2rem; }
  .btn { padding: 0.75rem 1.5rem; border-radius: 6px; font-size: 1rem; cursor: pointer; border: none; }
  .btn-primary { background: #0070f3; color: #fff; }
  .btn-secondary { background: transparent; border: 1px solid #e5e7eb; }
</style></head><body>
<div class="card">
  <h1>${serverName}</h1>
  ${serverDescription ? `<p>${serverDescription}</p>` : ""}
  <div class="alert"><strong>${clientName}</strong> is requesting access</div>
  <p>If you approve, you will be redirected to Notion to authorize access to your workspace.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="state" value="${encodedState}">
    <input type="hidden" name="csrf_token" value="${csrfToken}">
    <div class="actions">
      <button type="button" class="btn btn-secondary" onclick="window.close()">Cancel</button>
      <button type="submit" class="btn btn-primary">Approve</button>
    </div>
  </form>
</div></body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Set-Cookie": setCookie,
    },
  });
}

// --- Internal helpers ---

async function getApprovedClientsFromCookie(request: Request, cookieSecret: string): Promise<string[] | null> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const targetCookie = cookies.find((c) => c.startsWith("__Host-APPROVED_CLIENTS="));
  if (!targetCookie) return null;

  const cookieValue = targetCookie.substring("__Host-APPROVED_CLIENTS=".length);
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;

  const [signatureHex, base64Payload] = parts;
  const payload = atob(base64Payload);
  const isValid = await verifySignature(signatureHex, payload, cookieSecret);
  if (!isValid) return null;

  try {
    const approvedClients = JSON.parse(payload);
    if (!Array.isArray(approvedClients) || !approvedClients.every((item) => typeof item === "string")) return null;
    return approvedClients as string[];
  } catch {
    return null;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]);
}

async function signData(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySignature(signatureHex: string, data: string, secret: string): Promise<boolean> {
  const key = await importKey(secret);
  try {
    const sigBytes = new Uint8Array(signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)));
    return await crypto.subtle.verify("HMAC", key, sigBytes.buffer, new TextEncoder().encode(data));
  } catch {
    return false;
  }
}
