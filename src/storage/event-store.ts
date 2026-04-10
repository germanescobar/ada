import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { AgentEvent, EventType } from "../types/events.js";

export class EventStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async append(
    sessionId: string,
    type: EventType,
    data: Record<string, unknown>
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: uuidv4(),
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      data,
    };

    await fs.mkdir(this.baseDir, { recursive: true });
    const filePath = path.join(this.baseDir, `${sessionId}.jsonl`);
    await fs.appendFile(filePath, JSON.stringify(event) + "\n");
    return event;
  }

  async getEvents(sessionId: string): Promise<AgentEvent[]> {
    const filePath = path.join(this.baseDir, `${sessionId}.jsonl`);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentEvent);
    } catch {
      return [];
    }
  }
}
