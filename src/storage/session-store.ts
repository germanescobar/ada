import fs from "node:fs/promises";
import path from "node:path";
import type { SessionState } from "../types/agent.js";

export class SessionStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async save(session: SessionState): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const filePath = path.join(this.baseDir, `${session.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  }

  async load(sessionId: string): Promise<SessionState | null> {
    const filePath = path.join(this.baseDir, `${sessionId}.json`);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as SessionState;
    } catch {
      return null;
    }
  }

  async list(includeArchived = false): Promise<SessionState[]> {
    try {
      const files = await fs.readdir(this.baseDir);
      const sessions: SessionState[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await fs.readFile(
          path.join(this.baseDir, file),
          "utf-8"
        );
        const session = JSON.parse(content) as SessionState;
        if (!includeArchived && session.status === "archived") continue;
        sessions.push(session);
      }
      sessions.sort(
        (a, b) =>
          new Date(b.lastActiveAt).getTime() -
          new Date(a.lastActiveAt).getTime()
      );
      return sessions;
    } catch {
      return [];
    }
  }

  async archive(sessionId: string): Promise<void> {
    const session = await this.load(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.status = "archived";
    await this.save(session);
  }

  async getLatest(): Promise<SessionState | null> {
    const sessions = await this.list();
    return sessions[0] ?? null;
  }
}
