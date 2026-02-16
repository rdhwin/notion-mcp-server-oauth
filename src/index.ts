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
  updateDatabase,
  createPage,
  updatePage,
  archivePage,
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
      description: `Query items in a Notion database. Returns flattened properties.

IMPORTANT: Call get-database-schema first to discover exact property names and types before building filters.

Filter syntax — wrap conditions in a top-level compound ("and"/"or") or use a single condition:
  { "property": "<name>", "<type>": { "<operator>": "<value>" } }

Operators by property type:
  - title/rich_text: equals, does_not_equal, contains, does_not_contain, starts_with, ends_with, is_empty, is_not_empty
  - number: equals, does_not_equal, greater_than, less_than, greater_than_or_equal_to, less_than_or_equal_to, is_empty, is_not_empty
  - checkbox: equals (true/false)
  - select/status: equals, does_not_equal, is_empty, is_not_empty
  - multi_select: contains, does_not_contain, is_empty, is_not_empty
  - date: equals, before, after, on_or_before, on_or_after, is_empty, is_not_empty (values are ISO 8601 strings)
  - people/relation: contains, does_not_contain, is_empty, is_not_empty
  - formula: use the output type operators (string/number/date/checkbox)

Compound filters:
  { "and": [ ...conditions ] }  or  { "or": [ ...conditions ] }

Sort syntax — array of objects:
  { "property": "<name>", "direction": "ascending" | "descending" }
  { "timestamp": "created_time" | "last_edited_time", "direction": "ascending" | "descending" }`,
      inputSchema: {
        database_id: z.string().describe("The Notion data source ID or URL"),
        filter: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            'Notion filter object. Single condition: { "property": "Status", "status": { "equals": "Done" } }. Compound: { "and": [...conditions] }',
          ),
        sorts: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe(
            'Array of sort objects. Example: [{ "property": "Created", "direction": "descending" }]',
          ),
        page_size: z
          .number()
          .optional()
          .describe("Max results per page (default 100, fetches all pages)"),
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

    this.server.registerTool("update-database", {
      description: `Update a Notion database's title or properties (columns). Use this to add, rename, or remove columns.

To ADD a new property:
  { "New Column": { "rich_text": {} } }  — creates a text column
  { "Priority": { "select": { "options": [{ "name": "High" }, { "name": "Low" }] } } }

To RENAME a property:
  { "Old Name": { "name": "New Name" } }

To DELETE a property:
  { "Column Name": null }

Common property type configs:
  - rich_text: {}
  - number: { "format": "number" }  (or "percent", "dollar", "euro", etc.)
  - select: { "options": [{ "name": "A" }, { "name": "B" }] }
  - multi_select: { "options": [{ "name": "Tag1" }, { "name": "Tag2" }] }
  - date: {}
  - checkbox: {}
  - url: {}
  - email: {}
  - phone_number: {}`,
      inputSchema: {
        database_id: z.string().describe("The Notion database ID or URL"),
        title: z.string().optional().describe("New title for the database"),
        properties: z
          .record(z.string(), z.any())
          .optional()
          .describe("Properties to add, update, or remove. Set value to null to delete a column."),
      },
    }, async ({ database_id, title, properties }) => {
      const result = await updateDatabase(token, normalizeId(database_id), { title, properties });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    this.server.registerTool("create-database-item", {
      description: `Add a new item (row) to a Notion database. Call get-database-schema first to know the property names and types.

Property value formats by type:
  - title:        { "title": [{ "text": { "content": "My Title" } }] }
  - rich_text:    { "rich_text": [{ "text": { "content": "Some text" } }] }
  - number:       { "number": 42 }
  - select:       { "select": { "name": "Option A" } }
  - multi_select: { "multi_select": [{ "name": "Tag1" }, { "name": "Tag2" }] }
  - status:       { "status": { "name": "In Progress" } }
  - date:         { "date": { "start": "2025-01-15", "end": "2025-01-20" } }  (end is optional)
  - checkbox:     { "checkbox": true }
  - url:          { "url": "https://example.com" }
  - email:        { "email": "a@b.com" }
  - phone_number: { "phone_number": "+1234567890" }
  - relation:     { "relation": [{ "id": "page-id-1" }] }
  - people:       { "people": [{ "id": "user-id" }] }`,
      inputSchema: {
        database_id: z.string().describe("The Notion database ID or URL"),
        properties: z
          .record(z.string(), z.any())
          .describe("Property values for the new item. Keys are property names, values follow Notion API format."),
      },
    }, async ({ database_id, properties }) => {
      const page = await createPage(token, {
        parent: { database_id: normalizeId(database_id) },
        properties,
      });
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    });

    this.server.registerTool("update-page-properties", {
      description: `Update properties of an existing Notion page or database item. Same property value format as create-database-item.

Property value formats by type:
  - title:        { "title": [{ "text": { "content": "My Title" } }] }
  - rich_text:    { "rich_text": [{ "text": { "content": "Some text" } }] }
  - number:       { "number": 42 }
  - select:       { "select": { "name": "Option A" } }
  - multi_select: { "multi_select": [{ "name": "Tag1" }, { "name": "Tag2" }] }
  - status:       { "status": { "name": "Done" } }
  - date:         { "date": { "start": "2025-01-15" } }
  - checkbox:     { "checkbox": true }
  - url:          { "url": "https://example.com" }
  - email:        { "email": "a@b.com" }
  - phone_number: { "phone_number": "+1234567890" }
  - relation:     { "relation": [{ "id": "page-id-1" }] }
  - people:       { "people": [{ "id": "user-id" }] }`,
      inputSchema: {
        page_id: z.string().describe("The Notion page ID or URL"),
        properties: z
          .record(z.string(), z.any())
          .describe("Property values to update. Keys are property names, values follow Notion API format."),
      },
    }, async ({ page_id, properties }) => {
      const page = await updatePage(token, normalizeId(page_id), properties);
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    });

    this.server.registerTool("delete-page", {
      description: "Delete (archive) a Notion page or database item. This moves it to trash — it can be restored from Notion's trash.",
      inputSchema: {
        page_id: z.string().describe("The Notion page ID or URL to archive/delete"),
      },
    }, async ({ page_id }) => {
      const result = await archivePage(token, normalizeId(page_id));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    this.server.registerTool("create-page", {
      description: `Create a new standalone Notion page under an existing page. For adding items to a database, use create-database-item instead.

Content blocks (children) examples:
  - Paragraph:  { "object": "block", "type": "paragraph", "paragraph": { "rich_text": [{ "type": "text", "text": { "content": "Hello world" } }] } }
  - Heading 1:  { "object": "block", "type": "heading_1", "heading_1": { "rich_text": [{ "type": "text", "text": { "content": "Title" } }] } }
  - Heading 2:  { "object": "block", "type": "heading_2", "heading_2": { "rich_text": [{ "type": "text", "text": { "content": "Subtitle" } }] } }
  - Bullet:     { "object": "block", "type": "bulleted_list_item", "bulleted_list_item": { "rich_text": [{ "type": "text", "text": { "content": "Item" } }] } }
  - Numbered:   { "object": "block", "type": "numbered_list_item", "numbered_list_item": { "rich_text": [{ "type": "text", "text": { "content": "Step 1" } }] } }
  - To-do:      { "object": "block", "type": "to_do", "to_do": { "rich_text": [{ "type": "text", "text": { "content": "Task" } }], "checked": false } }
  - Code:       { "object": "block", "type": "code", "code": { "rich_text": [{ "type": "text", "text": { "content": "console.log('hi')" } }], "language": "javascript" } }
  - Divider:    { "object": "block", "type": "divider", "divider": {} }`,
      inputSchema: {
        parent_page_id: z.string().describe("The parent page ID or URL to create the new page under"),
        title: z.string().describe("Title of the new page"),
        children: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe("Array of block objects for the page content"),
      },
    }, async ({ parent_page_id, title, children }) => {
      const page = await createPage(token, {
        parent: { page_id: normalizeId(parent_page_id) },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
        children,
      });
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
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
