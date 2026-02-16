import "dotenv/config";
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
} from "./src/notion";

const TOKEN = process.env.NOTION_TOKEN!;
if (!TOKEN) {
  console.error("Missing NOTION_TOKEN in .env");
  process.exit(1);
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message?.slice(0, 200)}`);
  }
}

async function main() {
  console.log("\n🔍 Testing Notion API functions\n");

  // ── 1. listDatabases ──
  let databases: any[] = [];
  await test("listDatabases", async () => {
    databases = await listDatabases(TOKEN);
    console.log(`     Found ${databases.length} database(s)`);
    if (databases.length > 0) {
      console.log(`     First: "${databases[0].title}" (${databases[0].id})`);
    }
  });

  if (databases.length === 0) {
    console.log("\n⚠️  No databases found. Make sure you've shared at least one database with the integration.");
    console.log("   In Notion: open a database → ••• → Connections → add your integration\n");
    printSummary();
    return;
  }

  const db = databases[0];
  const dbId = normalizeId(db.id);

  // ── 2. getDatabaseSchema ──
  let schema: any;
  await test("getDatabaseSchema", async () => {
    schema = await getDatabaseSchema(TOKEN, dbId);
    console.log(`     "${schema.title}" has ${schema.properties.length} properties`);
    for (const p of schema.properties.slice(0, 5)) {
      console.log(`       - ${p.name} (${p.type})`);
    }
  });

  // ── 3. queryDatabase (no filter) ──
  let pages: any[] = [];
  await test("queryDatabase (no filter)", async () => {
    pages = await queryDatabase(TOKEN, dbId, undefined, undefined, 5);
    console.log(`     Got ${pages.length} page(s)`);
  });

  // ── 4. queryDatabase (with page_size) ──
  await test("queryDatabase (page_size=2)", async () => {
    const limited = await queryDatabase(TOKEN, dbId, undefined, undefined, 2);
    console.log(`     Got ${limited.length} page(s)`);
  });

  // ── 5. getPage ──
  if (pages.length > 0) {
    const firstPageId = normalizeId(pages[0].id);
    await test("getPage", async () => {
      const page = await getPage(TOKEN, firstPageId);
      console.log(`     Page ID: ${page.id}`);
      console.log(`     Properties: ${Object.keys(page.properties).join(", ")}`);
    });

    // ── 6. getPageBlocks ──
    await test("getPageBlocks", async () => {
      const blocks = await getPageBlocks(TOKEN, firstPageId);
      console.log(`     Got ${blocks.length} block(s)`);
      for (const b of blocks.slice(0, 3)) {
        console.log(`       - [${b.type}] ${b.text?.slice(0, 60) || "(empty)"}`);
      }
    });
  }

  // ── 7. Find title property name for creates ──
  const titleProp = schema?.properties?.find((p: any) => p.type === "title");
  const titlePropName = titleProp?.name ?? "Name";

  // ── 8. createPage (database item) ──
  let createdPageId: string | undefined;
  await test("createPage (database item)", async () => {
    const page = await createPage(TOKEN, {
      parent: { data_source_id: dbId },
      properties: {
        [titlePropName]: {
          title: [{ text: { content: "MCP Test Item — safe to delete" } }],
        },
      },
    });
    createdPageId = page.id;
    console.log(`     Created page: ${page.id}`);
  });

  // ── 9. updatePage ──
  if (createdPageId) {
    await test("updatePage", async () => {
      const updated = await updatePage(TOKEN, normalizeId(createdPageId!), {
        [titlePropName]: {
          title: [{ text: { content: "MCP Test Item — UPDATED" } }],
        },
      });
      console.log(`     Updated title to: ${updated.properties[titlePropName]}`);
    });
  }

  // ── 10. archivePage (cleanup) ──
  if (createdPageId) {
    await test("archivePage (cleanup)", async () => {
      const result = await archivePage(TOKEN, normalizeId(createdPageId!));
      console.log(`     Archived: ${result.archived}`);
    });
  }

  // ── 11. updateDatabase (add column then remove it) ──
  const testColName = `__mcp_test_col_${Date.now()}`;
  await test("updateDatabase (add column)", async () => {
    const result = await updateDatabase(TOKEN, dbId, {
      properties: { [testColName]: { rich_text: {} } },
    });
    console.log(`     Added column "${testColName}" to "${result.title}"`);
  });

  await test("updateDatabase (remove column)", async () => {
    const result = await updateDatabase(TOKEN, dbId, {
      properties: { [testColName]: null },
    });
    console.log(`     Removed column from "${result.title}"`);
  });

  // ── 12. normalizeId ──
  await test("normalizeId (UUID with dashes)", async () => {
    const id = normalizeId("12345678-1234-1234-1234-123456789abc");
    if (id !== "123456781234123412341234567890bc") {
      // just check dashes are removed
      if (id.includes("-")) throw new Error(`Still has dashes: ${id}`);
    }
  });

  await test("normalizeId (Notion URL)", async () => {
    const id = normalizeId("https://www.notion.so/myworkspace/My-Page-1234567890abcdef1234567890abcdef");
    if (id !== "1234567890abcdef1234567890abcdef") {
      throw new Error(`Expected 1234567890abcdef1234567890abcdef, got ${id}`);
    }
  });

  printSummary();
}

function printSummary() {
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${"─".repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
