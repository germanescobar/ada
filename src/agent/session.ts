import { v4 as uuidv4 } from "uuid";
import type { SessionState } from "../types/agent.js";
import type { SessionStore } from "../storage/session-store.js";
import type { EventStore } from "../storage/event-store.js";

export class SessionManager {
  constructor(
    private sessionStore: SessionStore,
    private eventStore: EventStore
  ) {}

  async createSession(
    workingDirectory: string,
    model: string
  ): Promise<SessionState> {
    const session: SessionState = {
      id: uuidv4(),
      workingDirectory,
      model,
      messages: [],
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
    };

    await this.sessionStore.save(session);
    await this.eventStore.append(session.id, "session_start", {
      workingDirectory,
      model,
    });

    return session;
  }

  async resumeSession(sessionId: string): Promise<SessionState> {
    const session = await this.sessionStore.load(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.status = "active";
    return session;
  }

  async listSessions(): Promise<SessionState[]> {
    return this.sessionStore.list();
  }
}
