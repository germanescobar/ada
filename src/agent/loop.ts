import chalk from "chalk";
import type { ModelProvider } from "../models/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventStore } from "../storage/event-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { SessionState } from "../types/agent.js";
import type { ContentBlock, Message } from "../types/messages.js";
import type { StreamEvent } from "../types/stream.js";
import { ContextBuilder } from "./context-builder.js";
import { Executor } from "./executor.js";

const MAX_ITERATIONS = 50;

export class AgentLoop {
  constructor(
    private provider: ModelProvider,
    private executor: Executor,
    private contextBuilder: ContextBuilder,
    private registry: ToolRegistry,
    private eventStore: EventStore,
    private sessionStore: SessionStore,
    private streamJson = false
  ) {}

  async run(session: SessionState, userMessage: string): Promise<void> {
    // Append user message
    session.messages.push({ role: "user", content: userMessage });
    session.lastActiveAt = new Date().toISOString();
    if (!session.title) {
      session.title = this.generateTitle(userMessage);
    }
    await this.eventStore.append(session.id, "user_message", {
      text: userMessage,
    });

    const systemPrompt = await this.contextBuilder.buildSystemPrompt();
    const tools = this.registry.toSchemas();
    let finalStopReason = "max_iterations";
    let status: "completed" | "max_iterations" = "max_iterations";

    this.emit({
      type: "run.started",
      sessionId: session.id,
      model: session.model,
      workingDirectory: session.workingDirectory,
      timestamp: new Date().toISOString(),
    });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.provider.chat({
        systemPrompt,
        messages: session.messages,
        tools,
      });

      if (response.reasoning) {
        await this.eventStore.append(session.id, "assistant_reasoning", {
          text: response.reasoning,
        });
      }

      await this.eventStore.append(session.id, "assistant_response", {
        stopReason: response.stopReason,
        content: response.content,
        reasoning: response.reasoning,
        usage: response.usage,
      });

      // Append assistant response to messages
      session.messages.push({ role: "assistant", content: response.content });

      if (response.reasoning) {
        this.emit({ type: "assistant.reasoning", text: response.reasoning });
      }

      // Print any text blocks
      for (const block of response.content) {
        if (block.type === "text") {
          this.emit({ type: "assistant.text", text: block.text });
        }
      }

      // If no tool use, we're done
      finalStopReason = response.stopReason;
      if (response.stopReason !== "tool_use") {
        status = "completed";
        break;
      }

      // Execute tool calls
      const toolUseBlocks = response.content.filter(
        (b) => b.type === "tool_use"
      ) as Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;

      const resultBlocks: ContentBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        this.emit({
          type: "tool.call",
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        });

        const result = await this.executor.executeTool(session.id, {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        });

        this.emit({
          type: "tool.result",
          id: toolUse.id,
          name: toolUse.name,
          content: result.content,
          isError: Boolean(result.isError),
        });

        resultBlocks.push({
          type: "tool_result",
          toolUseId: toolUse.id,
          content: result.content,
          isError: result.isError,
        });
      }

      // Append tool results as user message
      session.messages.push({ role: "user", content: resultBlocks });
    }

    // Save session
    session.lastActiveAt = new Date().toISOString();
    await this.sessionStore.save(session);
    this.emit({
      type: "run.completed",
      sessionId: session.id,
      status,
      stopReason: finalStopReason as "end_turn" | "tool_use" | "max_tokens" | "error",
      timestamp: new Date().toISOString(),
    });
  }

  private generateTitle(message: string): string {
    const firstLine = message.split('\n')[0].trim();
    if (!firstLine) return 'Chat session';
    if (firstLine.length <= 72) return firstLine;
    return firstLine.slice(0, 69) + '...';
  }

  private emit(event: StreamEvent): void {
    if (this.streamJson) {
      console.log(JSON.stringify(event));
      return;
    }

    switch (event.type) {
      case "run.started":
      case "run.completed":
      case "run.failed":
        return;
      case "assistant.text":
        console.log(chalk.cyan(event.text));
        return;
      case "assistant.reasoning":
        console.log(chalk.magenta(event.text));
        return;
      case "tool.call":
        console.log(chalk.yellow(`→ ${event.name}(${JSON.stringify(event.input)})`));
        return;
      case "tool.result": {
        const preview = event.content.slice(0, 500);
        console.log(
          event.isError ? chalk.red(`  ✗ ${preview}`) : chalk.gray(`  ${preview}`)
        );
        return;
      }
    }
  }
}
