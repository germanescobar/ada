import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";
import type { ModelProvider } from "../models/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventStore } from "../storage/event-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { SessionState } from "../types/agent.js";
import type { ContentBlock, Message } from "../types/messages.js";
import type { AgentRunResult, OutputMode, ToolCallResult } from "../types/output.js";
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
    private outputMode: OutputMode = "default"
  ) {}

  async run(session: SessionState, userMessage: string): Promise<AgentRunResult> {
    // Append user message
    session.messages.push({ role: "user", content: userMessage });
    session.lastActiveAt = new Date().toISOString();
    await this.eventStore.append(session.id, "user_message", {
      text: userMessage,
    });

    const systemPrompt = await this.contextBuilder.buildSystemPrompt();
    const tools = this.registry.toSchemas();
    const textBlocks: string[] = [];
    const toolCalls: ToolCallResult[] = [];
    let finalStopReason = "max_iterations";
    let status: AgentRunResult["status"] = "max_iterations";

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.provider.chat({
        systemPrompt,
        messages: session.messages,
        tools,
      });

      await this.eventStore.append(session.id, "assistant_response", {
        stopReason: response.stopReason,
        content: response.content,
        usage: response.usage,
      });

      // Append assistant response to messages
      session.messages.push({ role: "assistant", content: response.content });

      // Print any text blocks
      for (const block of response.content) {
        if (block.type === "text") {
          textBlocks.push(block.text);
          if (this.outputMode !== "json") {
            console.log(chalk.cyan(block.text));
          }
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
        if (this.outputMode === "default") {
          console.log(
            chalk.yellow(`→ ${toolUse.name}(${JSON.stringify(toolUse.input)})`)
          );
        }

        const result = await this.executor.executeTool(session.id, {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        });

        const preview = result.content.slice(0, 500);
        if (this.outputMode === "default") {
          console.log(
            result.isError ? chalk.red(`  ✗ ${preview}`) : chalk.gray(`  ${preview}`)
          );
        }

        toolCalls.push({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
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

    return {
      schemaVersion: "ada.v1",
      sessionId: session.id,
      model: session.model,
      workingDirectory: session.workingDirectory,
      status,
      stopReason: finalStopReason,
      finalText: textBlocks.join("\n\n").trim(),
      textBlocks,
      toolCalls,
    };
  }
}
