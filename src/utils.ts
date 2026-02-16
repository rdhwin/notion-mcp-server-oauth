export type Props = {
  accessToken: string;
  workspaceId: string;
  workspaceName: string;
  botId: string;
};

/**
 * Constructs the Notion OAuth authorization URL.
 */
export function getNotionAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state?: string;
}): string {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  if (opts.state) url.searchParams.set("state", opts.state);
  return url.href;
}

/**
 * Exchanges a Notion authorization code for an access token.
 * Notion uses JSON body + Basic auth (base64(client_id:client_secret)).
 */
export async function fetchNotionToken(opts: {
  clientId: string;
  clientSecret: string;
  code: string | undefined;
  redirectUri: string;
}): Promise<[NotionTokenResponse, null] | [null, Response]> {
  const { clientId, clientSecret, code, redirectUri } = opts;
  if (!code) {
    return [null, new Response("Missing code", { status: 400 })];
  }

  const encoded = btoa(`${clientId}:${clientSecret}`);

  const resp = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${encoded}`,
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Notion token exchange failed:", text);
    return [null, new Response("Failed to exchange code for token", { status: 500 })];
  }

  const data = (await resp.json()) as NotionTokenResponse;

  if (!data.access_token) {
    return [null, new Response("Missing access_token in Notion response", { status: 500 })];
  }

  return [data, null];
}

export interface NotionTokenResponse {
  access_token: string;
  token_type: string;
  bot_id: string;
  workspace_id: string;
  workspace_name: string | null;
  workspace_icon: string | null;
  owner: any;
  duplicated_template_id: string | null;
  request_id: string;
}
