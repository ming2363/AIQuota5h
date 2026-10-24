import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LockHooks {
  afterHeld?: () => Promise<void> | void;
}

// 所有权是 SQLite 的 POSIX 记录锁，不是文件内容。进程崩溃后内核释放该锁，不需要回收门闩。
export class InstanceLock {
  private db: DatabaseSync | null = null;

  constructor(private readonly lockPath: string, private readonly hooks: LockHooks = {}) {}

  async acquire(): Promise<"acquired" | "busy"> {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const db = openDatabase(this.lockPath);
    db.exec("PRAGMA busy_timeout = 0");
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      db.close();
      if (isLocked(error)) return "busy";
      throw error;
    }
    try {
      if (this.hooks.afterHeld) await this.hooks.afterHeld();
    } catch (error) {
      releaseDatabase(db);
      throw error;
    }
    this.db = db;
    return "acquired";
  }

  async ping(): Promise<boolean> {
    if (this.db) return false;
    if (!fs.existsSync(this.lockPath)) return false;
    const db = openDatabase(this.lockPath);
    db.exec("PRAGMA busy_timeout = 0");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
      return false;
    } catch (error) {
      if (isLocked(error)) return true;
      throw error;
    } finally {
      db.close();
    }
  }

  async release(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (!db) return;
    releaseDatabase(db);
  }
}

function openDatabase(file: string): DatabaseSync {
  return new DatabaseSync(file);
}

function releaseDatabase(db: DatabaseSync): void {
  try { db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
  db.close();
}

function isLocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}
