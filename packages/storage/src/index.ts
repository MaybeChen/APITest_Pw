import { mkdirSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, and, desc } from "drizzle-orm";
import { redact } from "../../core/src/index.js";
export const documents = sqliteTable("documents", {
  kind: text("kind").notNull(),
  id: text("id").primaryKey(),
  entityId: text("entity_id").notNull(),
  version: integer("version").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
});
export class Store {
  db;
  client;
  constructor(url = "file:.data/platform.db") {
    mkdirSync(".data", { recursive: true });
    this.client = createClient({ url });
    this.db = drizzle(this.client);
  }
  async init() {
    await this.client.execute(
      "CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
  }
  async put(kind: string, entityId: string, version: number, data: unknown) {
    await this.db
      .insert(documents)
      .values({
        kind,
        id: `${kind}:${entityId}:${version}`,
        entityId,
        version,
        data: kind === "recording" || kind === "report" ? redact(data) : data,
        createdAt: Date.now(),
      });
  }
  async putBatch(
    entries: {
      kind: string;
      entityId: string;
      version: number;
      data: unknown;
    }[],
  ) {
    await this.client.batch(
      entries.map((e) => ({
        sql: "INSERT INTO documents (kind,id,entity_id,version,data,created_at) VALUES (?,?,?,?,?,?)",
        args: [
          e.kind,
          `${e.kind}:${e.entityId}:${e.version}`,
          e.entityId,
          e.version,
          JSON.stringify(e.data),
          Date.now(),
        ],
      })),
      "write",
    );
  }
  async get<T>(
    kind: string,
    entityId: string,
    version?: number,
  ): Promise<T | undefined> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.kind, kind),
          eq(documents.entityId, entityId),
          ...(version === undefined ? [] : [eq(documents.version, version)]),
        ),
      )
      .orderBy(desc(documents.version))
      .limit(1);
    return rows[0]?.data as T | undefined;
  }
  async list<T>(kind: string): Promise<T[]> {
    return (
      await this.db
        .select()
        .from(documents)
        .where(eq(documents.kind, kind))
        .orderBy(desc(documents.createdAt))
    ).map((r) => r.data as T);
  }
}
