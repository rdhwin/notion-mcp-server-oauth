import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { NotionHandler } from "./notion-handler";
import type { Props } from "./utils";
import {
  listDatabases,
  getDatabaseSchema,
  queryDatabase,
  getPage,
  getPageBlocks,
  normalizeId,
} from "./notion";

export class NotionMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: "notion-mcp",
    version: "1.0.0",
  });

  async init() {
    const token = this.props!.accessToken;

    this.server.registerTool("list-databases", {
      description: "List all Notion databases the integration can access",
    }, async () => {
      const dbs = await listDatabases(token);
      return { content: [{ type: "text", text: JSON.stringify(dbs, null, 2) }] };
    });

    this.server.registerTool("get-database-schema", {
      description: "Get the schema (columns, property types, select options) of a Notion database",
      inputSchema: { database_id: z.string().describe("The Notion data source ID (from list-databases) or URL") },
    }, async ({ database_id }) => {
      const schema = await getDatabaseSchema(token, normalizeId(database_id));
      return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
    });

    this.server.registerTool("query-database", {
      description: "Query all items in a Notion database with optional filters and sorts. Returns flattened properties.",
      inputSchema: {
        database_id: z.string().describe("The Notion data source ID or URL"),
        filter: z.any().optional().describe("Notion filter object"),
        sorts: z.any().optional().describe("Array of sort objects"),
        page_size: z.number().optional().describe("Max results per page (default 100, fetches all pages)"),
      },
    }, async ({ database_id, filter, sorts, page_size }) => {
      const pages = await queryDatabase(token, normalizeId(database_id), filter, sorts, page_size);
      return {
        content: [{ type: "text", text: JSON.stringify({ count: pages.length, results: pages }, null, 2) }],
      };
    });

    this.server.registerTool("get-page", {
      description: "Get a single Notion page and its properties",
      inputSchema: { page_id: z.string().describe("The Notion page ID or URL") },
    }, async ({ page_id }) => {
      const page = await getPage(token, normalizeId(page_id));
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    });

    this.server.registerTool("get-page-content", {
      description: "Get the block content (body text, headings, lists, code, etc.) of a Notion page",
      inputSchema: { page_id: z.string().describe("The Notion page ID or URL") },
    }, async ({ page_id }) => {
      const blocks = await getPageBlocks(token, normalizeId(page_id));
      return { content: [{ type: "text", text: JSON.stringify(blocks, null, 2) }] };
    });
  }
}

const oauthProvider = new OAuthProvider({
  apiHandler: NotionMCP.serve("/mcp"),
  apiRoute: "/mcp",
  defaultHandler: NotionHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // RFC 9728 Protected Resource Metadata — required by ChatGPT
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      const origin = url.origin;
      return new Response(
        JSON.stringify({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: [],
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    return (oauthProvider as any).fetch(request, env, ctx);
  },
};
