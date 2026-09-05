#!/usr/bin/env node
/**
 * Tencent Cloud VDB (Tencent VectorDB) data export script
 *
 * Connect to a Tencent Cloud vector database instance, query documents in a specified collection under the database, and export them as a .jsonl file.
 * Only Tencent Cloud vector database (Tencent VectorDB) is supported, and vector databases from other vendors are not supported.
 *
 * All connection parameters are passed via the CLI, no .env file is required.
 *
 * Usage:
 *   node ./bin/export-tencent-vdb.mjs --url <address> --username <username> --api-key <key> --database <database>
 *   node ./bin/export-tencent-vdb.mjs --url <address> --username <username> --api-key <key> --database <database> --probe
 *   node ./bin/export-tencent-vdb.mjs --url <address> --username <username> --api-key <key> --database <database> -c <collection> -o /tmp/backup
 *
 * Output:
 *   Default output to ./vdb-export-YYYY-MM-DD/ in the current working directory, which can be specified via -o.
 *   <outputDir>/
 *   ├── <collection>.jsonl    —  Each line contains one JSON document
 *   ├── schemas.json          — Exported collection table schema (indexes, embedding config, etc.)
 *   └── export-meta.json      — Export metadata
 *
 * Field description for export:
 *   Default behavior: export all fields, but skip vector (dense vector, 1024-dimensional float array, large size).
 *   Add --include-vectors: export all fields, including vector, without skipping anything.
 *   Note: sparse_vector (BM25 sparse vector) is always exported and is not affected by this switch.
 *
 * Dependency: Node.js >= 18 (built-in fetch)
 */

import fs from "node:fs";
import path from "node:path";

// ============================================================
// CLI argument parsing (including VDB connection information)
// ============================================================

interface VDBConfig {
  url: string;
  username: string;
  apiKey: string;
  database: string;
  timeout: number;
}

interface CliArgs {
  // Connection parameters
  url?: string;
  username?: string;
  apiKey?: string;
  database?: string;
  timeout: number;
  // Export parameters
  output: string;
  collection?: string;
  filter?: string;
  limit?: number;
  offset: number;
  includeVectors: boolean;
  probe: boolean;
  help: boolean;
}

const PAGE_SIZE = 100;

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    timeout: 30000,
    output: `./vdb-export-${new Date().toISOString().slice(0, 10)}`,
    offset: 0,
    includeVectors: false,
    probe: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--url":
        result.url = args[++i];
        break;
      case "--username":
        result.username = args[++i];
        break;
      case "--api-key":
        result.apiKey = args[++i];
        break;
      case "--database":
        result.database = args[++i];
        break;
      case "--timeout":
        result.timeout = parseInt(args[++i], 10) || 30000;
        break;
      case "--output":
      case "-o":
        result.output = args[++i];
        break;
      case "--collection":
      case "-c":
        result.collection = args[++i];
        break;
      case "--filter":
      case "-f":
        result.filter = args[++i];
        break;
      case "--limit":
      case "-l": {
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v < 1) {
          console.error(`❌ --limit must be >= 1, received: ${args[i]}`);
          process.exit(1);
        }
        result.limit = v;
        break;
      }
      case "--offset": {
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v < 0) {
          console.error(`❌ --offset must be >= 0, received: ${args[i]}`);
          process.exit(1);
        }
        result.offset = v;
        break;
      }
      case "--include-vectors":
        result.includeVectors = true;
        break;
      case "--probe":
        result.probe = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
    }
  }

  return result;
}

function validateConfig(args: CliArgs): VDBConfig {
  const missing: string[] = [];
  if (!args.url) missing.push("--url");
  if (!args.username) missing.push("--username");
  if (!args.apiKey) missing.push("--api-key");
  if (!args.database) missing.push("--database");

  if (missing.length > 0) {
    console.error("❌ Missing required parameter:");
    for (const k of missing) {
      console.error(`   - ${k}`);
    }
    console.error();
    console.error("Example:");
    console.error();
    console.error('  node ./bin/export-tencent-vdb.mjs \\');
    console.error('    --url "http://your-vdb-host:8100" \\');
    console.error('    --username "root" \\');
    console.error('    --api-key "your-api-key" \\');
    console.error('    --database "your-database"');
    console.error();
    console.error("Use --help to view the full parameter description.");
    process.exit(1);
  }

  return {
    url: args.url!,
    username: args.username!,
    apiKey: args.apiKey!,
    database: args.database!,
    timeout: args.timeout,
  };
}

function printHelp(): void {
  console.log(`
Tencent Cloud VDB (Tencent VectorDB) data export script

Usage:
  node ./bin/export-tencent-vdb.mjs [connection parameters] [options]

Connection parameters (required):
      --url <address>               VDB instance HTTP address (e.g., http://your-vdb-host:8100)
      --username <username>          Authentication username (e.g., root)
      --api-key <key>                Authentication key
      --database <database>          Database name

Options:
      --timeout <milliseconds>            Single request timeout (default: 30000)
  -o, --output <dir>            Output directory (default: ./vdb-export-YYYY-MM-DD)
  -c, --collection <full name>         export the specified collection (export all if not specified)
  -f, --filter <expression>          VDB Filter filter conditions (such as 'agent_id = "xxx"')
  -l, --limit <count>              Maximum number of entries to export (all if not specified)
      --offset <offset>             Start from which page (default: 0), must be a multiple of the page size
      --include-vectors           Keep the vector dense vector field (default: skip)
      --probe                     Only test connectivity, list collection information and exit
  -h, --help                      Display help

Output:
  <outputDir>/
  ├── <collection full name>.jsonl      One JSON document per line
  ├── schemas.json                Table schema
  └── export-meta.json            Export metadata

Field description for export:
  Skip vector (dense vector) by default, keep sparse_vector (BM25).
  Add --include-vectors to export all fields.

Example:
  # Test connectivity
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb \\
    --probe

  # Full Export
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb

  # Export specified collection to specified directory
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb \\
    -c mydb_l0_conversations -o /tmp/backup

  # With Filter Conditions
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb \\
    -f 'role = "user"'
`);
}

// ============================================================
// VDB HTTP Client
// ============================================================

class VDBClient {
  private baseUrl: string;
  private authHeader: string;
  private database: string;
  private timeout: number;

  constructor(cfg: VDBConfig) {
    this.baseUrl = cfg.url.replace(/\/$/, "");
    this.authHeader = `Bearer account=${cfg.username}&api_key=${cfg.apiKey}`;
    this.database = cfg.database;
    this.timeout = cfg.timeout;
  }

  async request<T>(apiPath: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${apiPath}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "(unable to read body)");
      throw new Error(`VDB API error: HTTP ${resp.status} — ${text.slice(0, 500)}`);
    }

    const json = (await resp.json()) as { code: number; msg: string } & T;
    if (json.code !== 0) {
      throw new Error(`VDB API error [${apiPath}]: code=${json.code}, msg=${json.msg}`);
    }
    return json;
  }

  async listCollections(): Promise<
    Array<{ collection: string; documentCount: number }>
  > {
    const result = await this.request<{
      collections: Array<{
        collection: string;
        documentCount: number;
        [key: string]: unknown;
      }>;
    }>("/collection/list", {
      database: this.database,
    });
    return (result.collections || []).map((c) => ({
      collection: c.collection,
      documentCount: c.documentCount ?? 0,
    }));
  }

  async queryDocuments(
    collection: string,
    options: {
      limit: number;
      offset: number;
      filter?: string;
      retrieveVector?: boolean;
    },
  ): Promise<{
    documents: Array<Record<string, unknown>>;
    count: number;
  }> {
    const query: Record<string, unknown> = {
      limit: options.limit,
      offset: options.offset,
    };
    if (options.filter) {
      query.filter = options.filter;
    }
    if (options.retrieveVector) {
      query.retrieveVector = true;
    }

    const result = await this.request<{
      documents: Array<Record<string, unknown>>;
      count: number;
    }>("/document/query", {
      database: this.database,
      collection,
      readConsistency: "strongConsistency",
      query,
    });

    return {
      documents: result.documents || [],
      count: result.count ?? 0,
    };
  }

  async describeCollection(collection: string): Promise<Record<string, unknown>> {
    const result = await this.request<{
      collection: Record<string, unknown>;
    }>("/collection/describe", {
      database: this.database,
      collection,
    });
    return result.collection || {};
  }
}

// ============================================================
// Export logic
// ============================================================

interface ExportOptions {
  filter?: string;
  limit?: number;
  offset: number;
  includeVectors: boolean;
  expectedTotal?: number;
}

async function exportCollection(
  client: VDBClient,
  collection: string,
  outputDir: string,
  options: ExportOptions,
): Promise<{ docCount: number; filePath: string }> {
  const filePath = path.join(outputDir, `${collection}.jsonl`);
  const writeStream = fs.createWriteStream(filePath, { encoding: "utf-8" });

  const isRangeMode = options.limit !== undefined;
  const maxDocs = options.limit ?? Infinity;
  const pageSize = isRangeMode ? Math.min(options.limit!, PAGE_SIZE) : PAGE_SIZE;

  let currentOffset = options.offset;
  let totalExported = 0;
  let hasMore = true;

  console.log(`  📦 ${collection}`);
  if (options.expectedTotal !== undefined) {
    console.log(`      Total documents: ${options.expectedTotal}`);
  }
  if (options.filter) {
    console.log(`      Filter condition: ${options.filter}`);
  }
  if (isRangeMode) {
    console.log(`     Export range: offset=${options.offset}, limit=${options.limit}`);
  }

  while (hasMore && totalExported < maxDocs) {
    const remaining = maxDocs - totalExported;
    const thisPageSize = Math.min(pageSize, remaining);

    try {
      const result = await client.queryDocuments(collection, {
        limit: thisPageSize,
        offset: currentOffset,
        filter: options.filter,
        retrieveVector: options.includeVectors,
      });

      const docs = result.documents;
      if (!docs || docs.length === 0) {
        hasMore = false;
        break;
      }

      for (const doc of docs) {
        const exportDoc = { ...doc };
        if (!options.includeVectors) {
          delete exportDoc.vector;
        }
        writeStream.write(JSON.stringify(exportDoc) + "\n");
      }

      totalExported += docs.length;
      currentOffset += docs.length;

      if (options.expectedTotal !== undefined && !isRangeMode) {
        const pct = Math.min(
          100,
          Math.round((totalExported / options.expectedTotal) * 100),
        );
        process.stdout.write(
          `\r      Progress: ${totalExported}/${options.expectedTotal} (${pct}%)`,
        );
      } else {
        process.stdout.write(`\r     Exported: ${totalExported} items`);
      }

      if (docs.length < thisPageSize) {
        hasMore = false;
      }
    } catch (err) {
      console.error(
        `\n     ❌ Query failed (offset=${currentOffset}): ${err instanceof Error ? err.message : String(err)}`,
      );
      hasMore = false;
    }
  }

  writeStream.end();
  await new Promise<void>((resolve) => writeStream.on("finish", resolve));

  console.log(
    `\n     ✅ Done: ${totalExported} → ${path.basename(filePath)}`
  );

  return { docCount: totalExported, filePath };
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const config = validateConfig(args);

  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║   Tencent Cloud VDB (Tencent VectorDB) Data Export Tool        ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log();
  console.log(`📌 VDB Address:     ${config.url}`);
  console.log(`📌 Database:       ${config.database}`);
  console.log(`📌 Output Directory:     ${args.output}`);
  if (args.collection) {
    console.log(`📌 Specified export:     ${args.collection}`);
  }
  if (args.filter) {
    console.log(`📌 Filter Condition:     ${args.filter}`);
  }
  if (args.limit !== undefined) {
    console.log(`📌 Export limit:     ${args.limit} items`);
  }
  if (args.offset > 0) {
    console.log(`📌 Start offset:     ${args.offset}`);
  }
  if (args.includeVectors) {
    console.log(`📌 Contains vector:      Yes`);
  }
  console.log();

  fs.mkdirSync(args.output, { recursive: true });

  const client = new VDBClient(config);

  let allCollections: Array<{ collection: string; documentCount: number }>;
  try {
    allCollections = await client.listCollections();
  } catch (err) {
    console.error(
      `❌ Failed to list collection: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  let targetCollections: Array<{ collection: string; documentCount: number }>;
  if (args.collection) {
    const found = allCollections.find((c) => c.collection === args.collection);
    if (!found) {
      console.error(
        `❌ Collection "${args.collection}" does not exist. Available collections:`
      );
      for (const c of allCollections) {
        console.error(`   - ${c.collection} (${c.documentCount} items)`);
      }
      process.exit(1);
    }
    targetCollections = [found];
  } else {
    targetCollections = allCollections;
    console.log(
      `🔍 Found ${targetCollections.length} collections:`
    );
    for (const c of targetCollections) {
      console.log(`   - ${c.collection} (${c.documentCount} items)`);
    }
  }

  if (targetCollections.length === 0) {
    console.log("⚠️  No collection in the database, no data to export");
    process.exit(0);
  }

  // --probe mode: only test connectivity, list information and exit
  if (args.probe) {
    console.log();
    console.log("✅ Connectivity test passed");
    console.log();
    console.log(`  VDB address:   ${config.url}`);
    console.log(`  Database:     ${config.database}`);
    console.log(`  Collection: ${targetCollections.length} items`);
    const totalDocs = targetCollections.reduce((s, c) => s + c.documentCount, 0);
    console.log(`   Total Documents:   ${totalDocs}`);
    console.log();
    for (const c of targetCollections) {
      console.log(`    - ${c.collection} (${c.documentCount} items)`);
    }
    console.log();
    process.exit(0);
  }

  console.log();

  // Get and save table structure
  const schemas: Record<string, Record<string, unknown>> = {};
  console.log("📐 Getting table structure...");
  for (const col of targetCollections) {
    try {
      const schema = await client.describeCollection(col.collection);
      schemas[col.collection] = schema;
      const indexCount = Array.isArray(schema.indexes) ? schema.indexes.length : 0;
      const emb = schema.embedding as Record<string, unknown> | undefined;
      const embInfo = emb ? `embedding=${emb.field}→${emb.model}` : "No embedding";
      console.log(`   ✅ ${col.collection} (${indexCount} indices, ${embInfo}`);
    } catch (err) {
      console.error(
        `   ⚠️ ${col.collection} table structure retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log();

  const schemaPath = path.join(args.output, "schemas.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schemas, null, 2) + "\n");

  const exportResults: Array<{
    collection: string;
    docCount: number;
    filePath: string;
  }> = [];

  for (const col of targetCollections) {
    try {
      const result = await exportCollection(client, col.collection, args.output, {
        filter: args.filter,
        limit: args.limit,
        offset: args.offset,
        includeVectors: args.includeVectors,
        expectedTotal: col.documentCount,
      });
      exportResults.push({ collection: col.collection, ...result });
    } catch (err) {
      console.error(
        `❌ Export ${col.collection} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      exportResults.push({
        collection: col.collection,
        docCount: 0,
        filePath: "",
      });
    }
    console.log();
  }

  const meta = {
    exportedAt: new Date().toISOString(),
    vdbUrl: config.url,
    database: config.database,
    filter: args.filter ?? null,
    offset: args.offset,
    limit: args.limit ?? null,
    includeVectors: args.includeVectors,
    collections: exportResults.map((r) => ({
      collection: r.collection,
      documentCount: r.docCount,
      file: r.filePath ? path.basename(r.filePath) : null,
    })),
    totalDocuments: exportResults.reduce((sum, r) => sum + r.docCount, 0),
  };

  const metaPath = path.join(args.output, "export-meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  console.log("═══════════════════════════════════════════════════");
  console.log("  ✅  Export Complete ");
  console.log("═══════════════════════════════════════════════════");
  console.log();
  console.log(`  📁 Output directory: ${args.output}`);
  console.log(`  📊 Total documents: ${meta.totalDocuments}`);
  for (const r of exportResults) {
    const status = r.docCount > 0 ? "✅" : "⚠️";
    console.log(
      `     ${status} ${r.collection}: ${r.docCount} items`
    );
  }
  console.log(`  📋  Metadata:   ${path.basename(metaPath)}`);
  console.log(`  📐  Table Structure:   ${path.basename(schemaPath)}`);
  console.log();
}

main().catch((err) => {
  console.error(
    `\n❌ Export failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
