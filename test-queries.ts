import "dotenv/config";
import {
  listDatabases,
  queryDatabase,
  createPage,
  createDatabase,
  archiveDatabase,
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
const createdPageIds: string[] = [];
let testDbId: string | undefined;
let testDbContainerId: string | undefined;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message?.slice(0, 300)}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertIds(actual: string[], expected: string[], msg: string) {
  const a = actual.map((id) => normalizeId(id)).sort();
  const e = expected.map((id) => normalizeId(id)).sort();
  assert(
    a.length === e.length && a.every((id, i) => id === e[i]),
    `${msg}\n       expected: [${e.join(", ")}]\n       actual:   [${a.join(", ")}]`,
  );
}

function assertOrder(actual: string[], expected: string[], msg: string) {
  const a = actual.map((id) => normalizeId(id));
  const e = expected.map((id) => normalizeId(id));
  assert(
    a.length === e.length && a.every((id, i) => id === e[i]),
    `${msg}\n       expected order: [${e.join(", ")}]\n       actual order:   [${a.join(", ")}]`,
  );
}

async function main() {
  console.log("\n🧪 Query & Filter Integration Tests\n");

  // ── Find a parent page to host our test database ──
  let parentPageId: string | undefined;

  await test("find parent page", async () => {
    const dbs = await listDatabases(TOKEN);
    assert(dbs.length > 0, "No databases found — need at least one to get a parent page");
    const pages = await queryDatabase(TOKEN, normalizeId(dbs[0].id), undefined, undefined, 1);
    assert(pages.length > 0, "No pages in first database — need at least one page as parent");
    parentPageId = normalizeId(pages[0].id);
    console.log(`     Using parent page: ${parentPageId}`);
  });

  if (!parentPageId) {
    console.log("\n⚠️  Cannot continue without a parent page.\n");
    printSummary();
    return;
  }

  // ── Create test database ──
  await test("create test database", async () => {
    const db = await createDatabase(TOKEN, {
      parentPageId,
      title: "MCP Query Test DB — safe to delete",
      properties: {
        Score: { number: { format: "number" } },
        Category: {
          select: {
            options: [
              { name: "A", color: "blue" },
              { name: "B", color: "green" },
              { name: "C", color: "red" },
            ],
          },
        },
        Done: { checkbox: {} },
        Due: { date: {} },
      },
    });
    testDbId = normalizeId(db.id);
    testDbContainerId = normalizeId(db.databaseId);
    console.log(`     Created: "${db.title}" (data_source: ${testDbId}, database: ${testDbContainerId})`);
  });

  if (!testDbId) {
    console.log("\n⚠️  Cannot continue without test database.\n");
    printSummary();
    return;
  }

  // ── Seed test items ──
  // Alpha: Score=10, Category=A, Done=true,  Due=2025-01-15
  // Beta:  Score=30, Category=B, Done=false, Due=2025-03-01
  // Gamma: Score=20, Category=A, Done=true,  Due=2025-02-10
  // Delta: Score=5,  Category=C, Done=false, Due=2025-04-20

  const items = [
    { name: "Alpha", score: 10, category: "A", done: true, due: "2025-01-15" },
    { name: "Beta", score: 30, category: "B", done: false, due: "2025-03-01" },
    { name: "Gamma", score: 20, category: "A", done: true, due: "2025-02-10" },
    { name: "Delta", score: 5, category: "C", done: false, due: "2025-04-20" },
  ];

  const itemIds: Record<string, string> = {};

  for (const item of items) {
    await test(`seed item: ${item.name}`, async () => {
      const page = await createPage(TOKEN, {
        parent: { data_source_id: testDbId! },
        properties: {
          Name: { title: [{ text: { content: item.name } }] },
          Score: { number: item.score },
          Category: { select: { name: item.category } },
          Done: { checkbox: item.done },
          Due: { date: { start: item.due } },
        },
      });
      itemIds[item.name] = page.id;
      createdPageIds.push(page.id);
      console.log(`     ${item.name}: ${page.id}`);
    });
  }

  if (Object.keys(itemIds).length < 4) {
    console.log("\n⚠️  Not all items seeded, skipping query tests.\n");
    await cleanup();
    printSummary();
    return;
  }

  // ── Query tests ──

  console.log("\n  📋 Filter tests\n");

  await test("filter: Done = true → Alpha, Gamma", async () => {
    const results = await queryDatabase(TOKEN, testDbId!, {
      property: "Done",
      checkbox: { equals: true },
    });
    assertIds(
      results.map((r: any) => r.id),
      [itemIds.Alpha, itemIds.Gamma],
      "Expected Alpha and Gamma",
    );
    console.log(`     Got ${results.length} result(s): ${results.map((r: any) => r.properties.Name).join(", ")}`);
  });

  await test("filter: Done = false → Beta, Delta", async () => {
    const results = await queryDatabase(TOKEN, testDbId!, {
      property: "Done",
      checkbox: { equals: false },
    });
    assertIds(
      results.map((r: any) => r.id),
      [itemIds.Beta, itemIds.Delta],
      "Expected Beta and Delta",
    );
    console.log(`     Got ${results.length} result(s): ${results.map((r: any) => r.properties.Name).join(", ")}`);
  });

  await test("filter: Category = 'A' → Alpha, Gamma", async () => {
    const results = await queryDatabase(TOKEN, testDbId!, {
      property: "Category",
      select: { equals: "A" },
    });
    assertIds(
      results.map((r: any) => r.id),
      [itemIds.Alpha, itemIds.Gamma],
      "Expected Alpha and Gamma",
    );
    console.log(`     Got ${results.length} result(s): ${results.map((r: any) => r.properties.Name).join(", ")}`);
  });

  await test("filter: Score > 15 → Beta, Gamma", async () => {
    const results = await queryDatabase(TOKEN, testDbId!, {
      property: "Score",
      number: { greater_than: 15 },
    });
    assertIds(
      results.map((r: any) => r.id),
      [itemIds.Beta, itemIds.Gamma],
      "Expected Beta and Gamma",
    );
    console.log(`     Got ${results.length} result(s): ${results.map((r: any) => r.properties.Name).join(", ")}`);
  });

  await test("filter: Due before 2025-02-15 → Alpha, Gamma", async () => {
    const results = await queryDatabase(TOKEN, testDbId!, {
      property: "Due",
      date: { before: "2025-02-15" },
    });
    assertIds(
      results.map((r: any) => r.id),
      [itemIds.Alpha, itemIds.Gamma],
      "Expected Alpha and Gamma",
    );
    console.log(`     Got ${results.length} result(s): ${results.map((r: any) => r.properties.Name).join(", ")}`);
  });

  await test("compound: Category=A AND Done=true → Alpha, Gamma", async () => {
    const results = await queryDatabase(TOKEN, testDbId!, {
      and: [
        { property: "Category", select: { equals: "A" } },
        { property: "Done", checkbox: { equals: true } },
      ],
    });
    assertIds(
      results.map((r: any) => r.id),
      [itemIds.Alpha, itemIds.Gamma],
      "Expected Alpha and Gamma",
    );
    console.log(`     Got ${results.length} result(s): ${results.map((r: any) => r.properties.Name).join(", ")}`);
  });

  await test("compound: Score > 10 OR Category=C → Beta, Gamma, Delta", async () => {
    const results = await queryDatabase(TOKEN, testDbId!, {
      or: [
        { property: "Score", number: { greater_than: 10 } },
        { property: "Category", select: { equals: "C" } },
      ],
    });
    assertIds(
      results.map((r: any) => r.id),
      [itemIds.Beta, itemIds.Gamma, itemIds.Delta],
      "Expected Beta, Gamma, Delta",
    );
    console.log(`     Got ${results.length} result(s): ${results.map((r: any) => r.properties.Name).join(", ")}`);
  });

  console.log("\n  📋 Sort tests\n");

  await test("sort: Score ascending → Delta, Alpha, Gamma, Beta", async () => {
    const results = await queryDatabase(
      TOKEN, testDbId!, undefined,
      [{ property: "Score", direction: "ascending" }],
    );
    assertOrder(
      results.map((r: any) => r.id),
      [itemIds.Delta, itemIds.Alpha, itemIds.Gamma, itemIds.Beta],
      "Wrong order",
    );
    const names = results.map((r: any) => `${r.properties.Name}(${r.properties.Score})`);
    console.log(`     ${names.join(" → ")}`);
  });

  await test("sort: Score descending → Beta, Gamma, Alpha, Delta", async () => {
    const results = await queryDatabase(
      TOKEN, testDbId!, undefined,
      [{ property: "Score", direction: "descending" }],
    );
    assertOrder(
      results.map((r: any) => r.id),
      [itemIds.Beta, itemIds.Gamma, itemIds.Alpha, itemIds.Delta],
      "Wrong order",
    );
    const names = results.map((r: any) => `${r.properties.Name}(${r.properties.Score})`);
    console.log(`     ${names.join(" → ")}`);
  });

  await test("sort: Due ascending → Alpha, Gamma, Beta, Delta", async () => {
    const results = await queryDatabase(
      TOKEN, testDbId!, undefined,
      [{ property: "Due", direction: "ascending" }],
    );
    assertOrder(
      results.map((r: any) => r.id),
      [itemIds.Alpha, itemIds.Gamma, itemIds.Beta, itemIds.Delta],
      "Wrong order",
    );
    const names = results.map((r: any) => `${r.properties.Name}(${r.properties.Due?.start})`);
    console.log(`     ${names.join(" → ")}`);
  });

  await test("filter + sort: Done=true, Score desc → Gamma, Alpha", async () => {
    const results = await queryDatabase(
      TOKEN, testDbId!,
      { property: "Done", checkbox: { equals: true } },
      [{ property: "Score", direction: "descending" }],
    );
    assertOrder(
      results.map((r: any) => r.id),
      [itemIds.Gamma, itemIds.Alpha],
      "Wrong order",
    );
    const names = results.map((r: any) => `${r.properties.Name}(${r.properties.Score})`);
    console.log(`     ${names.join(" → ")}`);
  });

  // ── Cleanup ──
  await cleanup();
  printSummary();
}

async function cleanup() {
  console.log("\n  🧹 Cleanup\n");

  for (const pageId of createdPageIds) {
    try {
      await archivePage(TOKEN, normalizeId(pageId));
    } catch {}
  }
  console.log(`  ✅ Archived ${createdPageIds.length} test items`);

  if (testDbContainerId) {
    await test("archive test database", async () => {
      const result = await archiveDatabase(TOKEN, testDbContainerId!);
      console.log(`     Archived database: ${result.id}`);
    });
  }
}

function printSummary() {
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${"─".repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  cleanup().finally(() => process.exit(1));
});
