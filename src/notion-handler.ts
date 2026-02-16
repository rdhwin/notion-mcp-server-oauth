import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { getNotionAuthorizeUrl, fetchNotionToken, type Props } from "./utils";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// GET /authorize — show approval dialog or redirect straight to Notion if already approved
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) return c.text("Invalid request", 400);

  if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionCookie } = await bindStateToSession(stateToken);
    return redirectToNotion(c.req.raw, stateToken, { "Set-Cookie": sessionCookie });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      name: "Notion MCP Server",
      description: "Connect your AI assistant to your Notion workspace.",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

// POST /authorize — user clicked Approve, redirect to Notion OAuth
app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") return c.text("Missing state", 400);

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

    const approvedCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedCookie);
    headers.append("Set-Cookie", sessionCookie);

    return redirectToNotion(c.req.raw, stateToken, Object.fromEntries(headers));
  } catch (error: any) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text(`Internal server error: ${error.message}`, 500);
  }
});

// GET /callback — Notion redirects here after user authorizes
app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: any) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

  // Exchange auth code for Notion access token
  const [tokenData, errResponse] = await fetchNotionToken({
    clientId: c.env.NOTION_OAUTH_CLIENT_ID,
    clientSecret: c.env.NOTION_OAUTH_CLIENT_SECRET,
    code: c.req.query("code"),
    redirectUri: new URL("/callback", c.req.url).href,
  });
  if (errResponse) return errResponse;

  // Complete the MCP OAuth flow — issue our own token to the MCP client
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: tokenData.bot_id,
    metadata: {
      label: tokenData.workspace_name ?? "Notion",
    },
    scope: oauthReqInfo.scope,
    props: {
      accessToken: tokenData.access_token,
      workspaceId: tokenData.workspace_id,
      workspaceName: tokenData.workspace_name ?? "",
      botId: tokenData.bot_id,
    } satisfies Props,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);

  return new Response(null, { status: 302, headers });
});

function redirectToNotion(
  request: Request,
  stateToken: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      ...extraHeaders,
      Location: getNotionAuthorizeUrl({
        clientId: env.NOTION_OAUTH_CLIENT_ID,
        redirectUri: new URL("/callback", request.url).href,
        state: stateToken,
      }),
    },
  });
}

export { app as NotionHandler };
