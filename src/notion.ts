const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: { ...headers(token), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API error ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Fetch all data sources via search (shared helper) ──
async function searchAllDataSources(token: string) {
  const results: any[] = [];
  let cursor: string | undefined;

  do {
    const body: any = { filter: { value: "data_source", property: "object" }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await notionFetch(token, "/search", { method: "POST", body: JSON.stringify(body) });
    results.push(...res.results);
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return results;
}

// ── List all databases the integration has access to ──
export async function listDatabases(token: string) {
  const results = await searchAllDataSources(token);

  return results.map((db: any) => ({
    id: db.id,
    title: db.title?.[0]?.plain_text ?? "(untitled)",
    url: db.url,
    created_time: db.created_time,
    last_edited_time: db.last_edited_time,
  }));
}

// ── Get database schema (properties / columns) ──
export async function getDatabaseSchema(token: string, databaseId: string) {
  const normalized = databaseId.replace(/-/g, "");
  const all = await searchAllDataSources(token);
  const db = all.find((d: any) => d.id.replace(/-/g, "") === normalized);

  if (!db) {
    throw new Error(`Database ${databaseId} not found. Make sure it's shared with the integration.`);
  }

  const properties = Object.entries(db.properties ?? {}).map(
    ([name, prop]: [string, any]) => ({
      name,
      type: prop.type,
      ...(prop.type === "select" ? { options: prop.select.options.map((o: any) => o.name) } : {}),
      ...(prop.type === "multi_select" ? { options: prop.multi_select.options.map((o: any) => o.name) } : {}),
      ...(prop.type === "status"
        ? {
            options: prop.status.options.map((o: any) => o.name),
            groups: prop.status.groups?.map((g: any) => ({ name: g.name, option_ids: g.option_ids })),
          }
        : {}),
    }),
  );

  return {
    id: db.id,
    title: db.title?.[0]?.plain_text ?? "(untitled)",
    properties,
  };
}

// ── Query a database with optional filter + sort ──
export async function queryDatabase(
  token: string,
  databaseId: string,
  filter?: any,
  sorts?: any[],
  pageSize?: number,
) {
  const allPages: any[] = [];
  let cursor: string | undefined;

  do {
    const body: any = { page_size: pageSize ?? 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;

    const res = await notionFetch(token, `/data_sources/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    for (const page of res.results) {
      allPages.push(flattenPage(page));
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return allPages;
}

// ── Get a single page's properties ──
export async function getPage(token: string, pageId: string) {
  const page = await notionFetch(token, `/pages/${pageId}`);
  return flattenPage(page);
}

// ── Create a new database under a parent page ──
export async function createDatabase(token: string, opts: {
  parentPageId: string;
  title: string;
  properties: Record<string, any>;
}) {
  const body: any = {
    parent: { page_id: opts.parentPageId },
    title: [{ type: "text", text: { content: opts.title } }],
    properties: {
      Name: { title: {} },
      ...opts.properties,
    },
  };

  const db = await notionFetch(token, "/data_sources", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    id: db.id,
    title: db.title?.[0]?.plain_text ?? "(untitled)",
    url: db.url,
  };
}

// ── Archive (delete) a database ──
export async function archiveDatabase(token: string, databaseId: string) {
  const db = await notionFetch(token, `/data_sources/${databaseId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  return { id: db.id, archived: true };
}

// ── Update database properties (add/rename/remove columns) ──
export async function updateDatabase(token: string, databaseId: string, updates: {
  title?: string;
  properties?: Record<string, any>;
}) {
  const body: any = {};
  if (updates.title !== undefined) {
    body.title = [{ type: "text", text: { content: updates.title } }];
  }
  if (updates.properties) {
    body.properties = updates.properties;
  }

  const db = await notionFetch(token, `/data_sources/${databaseId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

  return {
    id: db.id,
    title: db.title?.[0]?.plain_text ?? "(untitled)",
    url: db.url,
    last_edited_time: db.last_edited_time,
  };
}

// ── Create a page (in a database or as a standalone page) ──
export async function createPage(token: string, opts: {
  parent: { database_id?: string; page_id?: string };
  properties?: Record<string, any>;
  children?: any[];
}) {
  const body: any = {};

  if (opts.parent.database_id) {
    body.parent = { data_source_id: opts.parent.database_id };
  } else if (opts.parent.page_id) {
    body.parent = { page_id: opts.parent.page_id };
  }

  if (opts.properties) body.properties = opts.properties;
  if (opts.children) body.children = opts.children;

  const page = await notionFetch(token, "/pages", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return flattenPage(page);
}

// ── Update a page's properties ──
export async function updatePage(token: string, pageId: string, properties: Record<string, any>) {
  const page = await notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  return flattenPage(page);
}

// ── Archive (delete) a page ──
export async function archivePage(token: string, pageId: string) {
  const page = await notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  return { id: page.id, archived: true };
}

// ── Get page content (blocks) ──
export async function getPageBlocks(token: string, pageId: string) {
  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res = await notionFetch(token, `/blocks/${pageId}/children${qs}`);
    blocks.push(...res.results);
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return blocks.map(flattenBlock);
}

// ── Helpers ──

function flattenPage(page: any) {
  if (!page.properties) return { id: page.id, properties: {} };

  const props: Record<string, any> = {};
  for (const [key, val] of Object.entries(page.properties) as any[]) {
    props[key] = extractPropertyValue(val);
  }

  return {
    id: page.id,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    properties: props,
  };
}

function extractPropertyValue(prop: any): any {
  switch (prop.type) {
    case "title":
      return prop.title?.map((t: any) => t.plain_text).join("") ?? "";
    case "rich_text":
      return prop.rich_text?.map((t: any) => t.plain_text).join("") ?? "";
    case "number":
      return prop.number;
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      return prop.multi_select?.map((s: any) => s.name) ?? [];
    case "status":
      return prop.status?.name ?? null;
    case "date":
      return prop.date;
    case "checkbox":
      return prop.checkbox;
    case "url":
      return prop.url;
    case "email":
      return prop.email;
    case "phone_number":
      return prop.phone_number;
    case "formula":
      return extractPropertyValue(prop.formula);
    case "relation":
      return prop.relation?.map((r: any) => r.id) ?? [];
    case "rollup":
      return prop.rollup?.array?.map(extractPropertyValue) ?? prop.rollup;
    case "people":
      return prop.people?.map((p: any) => p.name ?? p.person?.email ?? p.id) ?? [];
    case "files":
      return prop.files?.map((f: any) => f.file?.url ?? f.external?.url ?? f.name) ?? [];
    case "created_time":
      return prop.created_time;
    case "last_edited_time":
      return prop.last_edited_time;
    case "created_by":
      return prop.created_by?.name ?? prop.created_by?.id;
    case "last_edited_by":
      return prop.last_edited_by?.name ?? prop.last_edited_by?.id;
    case "unique_id":
      return prop.unique_id ? `${prop.unique_id.prefix ?? ""}${prop.unique_id.number}` : null;
    default:
      return prop[prop.type] ?? null;
  }
}

function flattenBlock(block: any) {
  const type = block.type;
  const content = block[type];
  let text = "";

  if (content?.rich_text) {
    text = content.rich_text.map((t: any) => t.plain_text).join("");
  } else if (content?.title) {
    text = content.title;
  }

  return {
    id: block.id,
    type,
    text,
    has_children: block.has_children,
    ...(content?.url ? { url: content.url } : {}),
    ...(content?.language ? { language: content.language } : {}),
    ...(content?.checked !== undefined ? { checked: content.checked } : {}),
  };
}

export function normalizeId(idOrUrl: string): string {
  const urlMatch = idOrUrl.match(/(?:notion\.so|notion\.site)\/(?:.*[-/])?([a-f0-9]{32})/);
  if (urlMatch) return urlMatch[1];
  return idOrUrl.replace(/-/g, "");
}
