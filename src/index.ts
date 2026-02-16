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
      description: `List all Notion databases the integration can access. This is the starting point — call this first to discover available databases and get their IDs.

Returns an array of objects with: id, title, url, created_time, last_edited_time.

Use the returned "id" as the database_id input for get-database-schema, query-database, update-database, and create-database-item.`,
    }, async () => {
      const dbs = await listDatabases(token);
      return { content: [{ type: "text", text: JSON.stringify(dbs, null, 2) }] };
    });

    this.server.registerTool("get-database-schema", {
      description: `Get the schema (columns/properties) of a Notion database including property names, types, and options.

IMPORTANT: Always call this BEFORE query-database, create-database-item, or update-page-properties so you know the exact property names and types. Property names are case-sensitive.

Returns: id, title, and a properties array where each entry has: name, type, and (for select/multi_select/status) the available options.`,
      inputSchema: { database_id: z.string().describe("Database ID from list-databases, or a Notion URL") },
    }, async ({ database_id }) => {
      const schema = await getDatabaseSchema(token, normalizeId(database_id));
      return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
    });

    this.server.registerTool("query-database", {
      description: `Query items (rows) from a Notion database with optional filtering and sorting. Returns flattened properties for each item.

PREREQUISITE: Call get-database-schema first to discover exact property names and types — filters will fail if you guess wrong.

Returns: { count, results } where each result has id, url, created_time, last_edited_time, and a properties object with human-readable values.

## Filter syntax

Single condition:
  { "property": "<name>", "<type>": { "<operator>": <value> } }

Examples:
  { "property": "Status", "select": { "equals": "Done" } }
  { "property": "Priority", "number": { "greater_than": 3 } }
  { "property": "Done", "checkbox": { "equals": true } }
  { "property": "Due", "date": { "before": "2025-06-01" } }
  { "property": "Tags", "multi_select": { "contains": "Urgent" } }
  { "property": "Name", "title": { "contains": "report" } }

Compound filter (AND/OR):
  { "and": [{ "property": "Status", "select": { "equals": "Active" } }, { "property": "Score", "number": { "greater_than": 50 } }] }
  { "or": [{ "property": "Priority", "select": { "equals": "High" } }, { "property": "Done", "checkbox": { "equals": true } }] }

Operators by type:
  title/rich_text  → equals, does_not_equal, contains, does_not_contain, starts_with, ends_with, is_empty, is_not_empty
  number           → equals, does_not_equal, greater_than, less_than, greater_than_or_equal_to, less_than_or_equal_to, is_empty, is_not_empty
  checkbox         → equals (true or false)
  select/status    → equals, does_not_equal, is_empty, is_not_empty
  multi_select     → contains, does_not_contain, is_empty, is_not_empty
  date             → equals, before, after, on_or_before, on_or_after, is_empty, is_not_empty (ISO 8601 strings)
  people/relation  → contains, does_not_contain, is_empty, is_not_empty

## Sort syntax

Array of sort objects:
  [{ "property": "Score", "direction": "descending" }]
  [{ "timestamp": "last_edited_time", "direction": "ascending" }]
  [{ "property": "Category", "direction": "ascending" }, { "property": "Score", "direction": "descending" }]`,
      inputSchema: {
        database_id: z.string().describe("Database ID from list-databases, or a Notion URL"),
        filter: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            'Notion filter object. Example: { "property": "Status", "status": { "equals": "Done" } }. Compound: { "and": [...] } or { "or": [...] }',
          ),
        sorts: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe(
            'Sort order. Example: [{ "property": "Score", "direction": "descending" }]',
          ),
        page_size: z
          .number()
          .optional()
          .describe("Max items per internal page (1-100, default 100). All pages are fetched automatically — this controls batch size, not total results."),
      },
    }, async ({ database_id, filter, sorts, page_size }) => {
      const pages = await queryDatabase(token, normalizeId(database_id), filter, sorts, page_size);
      return {
        content: [{ type: "text", text: JSON.stringify({ count: pages.length, results: pages }, null, 2) }],
      };
    });

    this.server.registerTool("get-page", {
      description: `Get a single Notion page's metadata and property values. Use this to read the structured data (title, status, dates, etc.) of a specific page or database item.

Returns: id, url, created_time, last_edited_time, and properties (flattened to human-readable values).

Note: This returns property values only, NOT the page's body content. To read the actual text/blocks inside the page, use get-page-content instead.`,
      inputSchema: { page_id: z.string().describe("Page ID (from query-database results or a Notion URL)") },
    }, async ({ page_id }) => {
      const page = await getPage(token, normalizeId(page_id));
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    });

    this.server.registerTool("get-page-content", {
      description: `Get the body content (blocks) of a Notion page — paragraphs, headings, lists, code blocks, to-dos, etc.

Returns an array of blocks, each with: id, type, text, has_children, and type-specific fields (url, language, checked).

Note: This returns the page body only, NOT its properties. To read properties (title, status, dates, etc.), use get-page instead.`,
      inputSchema: { page_id: z.string().describe("Page ID (from query-database results or a Notion URL)") },
    }, async ({ page_id }) => {
      const blocks = await getPageBlocks(token, normalizeId(page_id));
      return { content: [{ type: "text", text: JSON.stringify(blocks, null, 2) }] };
    });

    this.server.registerTool("update-database", {
      description: `Modify a Notion database's structure — rename it, add/rename/remove columns (properties).

IMPORTANT: This changes the database schema (columns), NOT the data inside it. To update an item's values, use update-page-properties.

## Add a column
Set the property name as key with its type config as value:
  { "Notes": { "rich_text": {} } }
  { "Priority": { "select": { "options": [{ "name": "High" }, { "name": "Medium" }, { "name": "Low" }] } } }
  { "Score": { "number": { "format": "number" } } }
  { "Due Date": { "date": {} } }
  { "Completed": { "checkbox": {} } }

## Rename a column
  { "Old Name": { "name": "New Name" } }

## Delete a column
  { "Column Name": null }

Available property types: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, people, relation, formula, rollup, files, created_time, last_edited_time.

Number formats: number, number_with_commas, percent, dollar, euro, pound, yen, ruble, rupee, won, yuan, canadian_dollar, real.`,
      inputSchema: {
        database_id: z.string().describe("Database ID from list-databases, or a Notion URL"),
        title: z.string().optional().describe("New title for the database (omit to keep current title)"),
        properties: z
          .record(z.string(), z.any())
          .optional()
          .describe("Column changes. Key = column name, value = type config (to add/update), null (to delete), or { name: 'New Name' } (to rename)."),
      },
    }, async ({ database_id, title, properties }) => {
      const result = await updateDatabase(token, normalizeId(database_id), { title, properties });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    this.server.registerTool("create-database-item", {
      description: `Add a new item (row) to a Notion database.

PREREQUISITE: Call get-database-schema first to get the exact property names and types — names are case-sensitive and must match exactly.

Each property key is the column name, and the value format depends on the column type:
  title:        { "title": [{ "text": { "content": "My Title" } }] }
  rich_text:    { "rich_text": [{ "text": { "content": "Some text" } }] }
  number:       { "number": 42 }
  select:       { "select": { "name": "Option A" } }
  multi_select: { "multi_select": [{ "name": "Tag1" }, { "name": "Tag2" }] }
  status:       { "status": { "name": "In Progress" } }
  date:         { "date": { "start": "2025-01-15" } }  (optionally add "end": "2025-01-20")
  checkbox:     { "checkbox": true }
  url:          { "url": "https://example.com" }
  email:        { "email": "user@example.com" }
  phone_number: { "phone_number": "+1234567890" }
  relation:     { "relation": [{ "id": "<page-id>" }] }
  people:       { "people": [{ "id": "<user-id>" }] }

Returns the created page with its id, url, and flattened properties.`,
      inputSchema: {
        database_id: z.string().describe("Database ID from list-databases, or a Notion URL"),
        properties: z
          .record(z.string(), z.any())
          .describe("Property values keyed by column name. Every database has a title-type column (often called 'Name') which should be included."),
      },
    }, async ({ database_id, properties }) => {
      const page = await createPage(token, {
        parent: { data_source_id: normalizeId(database_id) },
        properties,
      });
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    });

    this.server.registerTool("update-page-properties", {
      description: `Update property values of an existing Notion page or database item. Only the properties you include will be changed — omitted properties are left untouched.

PREREQUISITE: Call get-database-schema to know the exact property names and types if updating a database item.

Property value format is the same as create-database-item:
  title:        { "title": [{ "text": { "content": "New Title" } }] }
  rich_text:    { "rich_text": [{ "text": { "content": "Updated text" } }] }
  number:       { "number": 99 }
  select:       { "select": { "name": "Option B" } }
  multi_select: { "multi_select": [{ "name": "Tag1" }, { "name": "Tag3" }] }
  status:       { "status": { "name": "Done" } }
  date:         { "date": { "start": "2025-06-01" } }
  checkbox:     { "checkbox": false }
  url:          { "url": "https://new-url.com" }
  email:        { "email": "new@example.com" }
  phone_number: { "phone_number": "+0987654321" }
  relation:     { "relation": [{ "id": "<page-id>" }] }
  people:       { "people": [{ "id": "<user-id>" }] }

To clear a property, set it to its empty value (e.g. { "rich_text": [] }, { "select": null }).

Returns the updated page with its id, url, and flattened properties.`,
      inputSchema: {
        page_id: z.string().describe("Page ID from query-database results, get-page, or a Notion URL"),
        properties: z
          .record(z.string(), z.any())
          .describe("Property values to update. Only included properties are changed; others remain untouched."),
      },
    }, async ({ page_id, properties }) => {
      const page = await updatePage(token, normalizeId(page_id), properties);
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    });

    this.server.registerTool("delete-page", {
      description: `Archive (soft-delete) a Notion page or database item. The item is moved to Notion's trash and can be restored by the user from the Notion UI.

Use this to remove items from a database or delete standalone pages. This is not reversible via the API — only through Notion's trash UI.`,
      inputSchema: {
        page_id: z.string().describe("Page ID to archive — from query-database results, get-page, or a Notion URL"),
      },
    }, async ({ page_id }) => {
      const result = await archivePage(token, normalizeId(page_id));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    this.server.registerTool("create-page", {
      description: `Create a new standalone Notion page as a child of an existing page. The page can include rich content blocks.

NOTE: To add a row to a database, use create-database-item instead — this tool is for freeform pages only.

## Content blocks (children)

Each block is an object with "object": "block", a "type", and the type-specific content:

Paragraph:
  { "object": "block", "type": "paragraph", "paragraph": { "rich_text": [{ "type": "text", "text": { "content": "Hello world" } }] } }

Headings:
  { "object": "block", "type": "heading_1", "heading_1": { "rich_text": [{ "type": "text", "text": { "content": "Main heading" } }] } }
  { "object": "block", "type": "heading_2", "heading_2": { "rich_text": [{ "type": "text", "text": { "content": "Subheading" } }] } }
  { "object": "block", "type": "heading_3", "heading_3": { "rich_text": [{ "type": "text", "text": { "content": "Sub-subheading" } }] } }

Lists:
  { "object": "block", "type": "bulleted_list_item", "bulleted_list_item": { "rich_text": [{ "type": "text", "text": { "content": "Bullet point" } }] } }
  { "object": "block", "type": "numbered_list_item", "numbered_list_item": { "rich_text": [{ "type": "text", "text": { "content": "Step 1" } }] } }

To-do:
  { "object": "block", "type": "to_do", "to_do": { "rich_text": [{ "type": "text", "text": { "content": "Task" } }], "checked": false } }

Code:
  { "object": "block", "type": "code", "code": { "rich_text": [{ "type": "text", "text": { "content": "console.log('hi')" } }], "language": "javascript" } }

Other:
  { "object": "block", "type": "divider", "divider": {} }
  { "object": "block", "type": "quote", "quote": { "rich_text": [{ "type": "text", "text": { "content": "A wise quote" } }] } }
  { "object": "block", "type": "callout", "callout": { "rich_text": [{ "type": "text", "text": { "content": "Important note" } }], "icon": { "emoji": "💡" } } }

Rich text formatting (applies inside any rich_text array):
  Bold:          { "type": "text", "text": { "content": "bold" }, "annotations": { "bold": true } }
  Italic:        { "type": "text", "text": { "content": "italic" }, "annotations": { "italic": true } }
  Code:          { "type": "text", "text": { "content": "code" }, "annotations": { "code": true } }
  Link:          { "type": "text", "text": { "content": "click here", "link": { "url": "https://example.com" } } }`,
      inputSchema: {
        parent_page_id: z.string().describe("Parent page ID or Notion URL — the new page will be nested under this page"),
        title: z.string().describe("Title of the new page"),
        children: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe("Array of block objects for the page body. Omit for an empty page."),
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
