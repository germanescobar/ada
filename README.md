# Coding Agent

An intelligent AI-powered coding agent that helps you write, edit, and run code. It provides conversational interactions with AI models while having direct access to your file system and shell commands.

## Features

- **Conversational AI** - Chat with AI models using natural language
- **File System Tools** - Read, write, and edit files seamlessly
- **Command Execution** - Run shell commands safely with approval prompts
- **Session Management** - Resume previous conversations and track history
- **Multi-Provider Support** - Switch between Anthropic Claude and OpenAI models
- **Event Logging** - Track all interactions and tool executions
- **Type-Safe** - Built with TypeScript for reliability and type safety

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd coding-agent

# Install dependencies
npm install

# Build the project
npm run build
```

## Usage

### Basic Chat

Start a new conversation:

```bash
npm run start -- chat "Create a simple React component that displays a greeting"
```

Or with development mode:

```bash
npm run dev -- chat "Create a simple React component that displays a greeting"
```

### Resume a Session

Continue from a previous conversation:

```bash
npm run start -- chat "Can you explain this code?" --resume <session-id>
```

### List Past Sessions

```bash
npm run start -- sessions
```

### View Event Logs

View detailed events for a specific session:

```bash
npm run start -- events <session-id>
```

### Custom Model

Use a different AI model:

```bash
npm run start -- chat "Your message here" --model anthropic/claude-sonnet-4-6
```

### Custom Base URL

Connect to a custom API endpoint:

```bash
npm run start -- chat "Your message here" --base-url https://api.example.com/v1
```

## Architecture

The Coding Agent is built with a modular architecture:

### Core Components

- **Agent Loop** - Manages the conversation cycle, including message handling and tool execution
- **Context Builder** - Constructs system prompts with file system information
- **Executor** - Executes AI-generated tool calls with safety policies
- **Provider** - Abstracts AI model interactions (Anthropic, OpenAI)
- **Tool Registry** - Manages available tools and their schemas

### Storage Layer

- **Event Store** - Persist all interactions and events
- **Session Store** - Save and retrieve conversation sessions

### Tools

- **read-file** - Read file contents
- **write-file** - Create or overwrite files
- **edit-file** - Edit existing files with precise replacements
- **run-command** - Execute shell commands (with approval)

## Project Structure

```
coding-agent/
├── src/
│   ├── agent/
│   │   ├── context-builder.ts    # Builds system prompts with context
│   │   ├── executor.ts            # Executes tool calls safely
│   │   ├── loop.ts                # Main conversation loop
│   │   ├── policies.ts            # Safety and approval policies
│   │   └── session.ts             # Session management
│   ├── cli/
│   │   └── index.ts               # Command-line interface
│   ├── models/
│   │   ├── anthropic.ts           # Anthropic Claude integration
│   │   ├── openai.ts              # OpenAI integration
│   │   ├── provider.ts            # AI provider abstraction
│   │   └── resolve.ts             # Provider factory
│   ├── storage/
│   │   ├── event-store.ts         # Persistent event store
│   │   └── session-store.ts       # Persistent session store
│   ├── tools/
│   │   ├── edit-file.ts           # Edit file tool
│   │   ├── read-file.ts           # Read file tool
│   │   ├── registry.ts            # Tool registry and schema generation
│   │   └── run-command.ts         # Command execution tool
│   ├── types/
│   │   ├── agent.ts               # Agent type definitions
│   │   ├── events.ts              # Event types
│   │   ├── messages.ts            # Message type definitions
│   │   └── tools.ts               # Tool type definitions
│   ├── CLI.ts
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

1. **User sends a message** via the CLI
2. **Context is built** based on the current working directory and conversation history
3. **AI model processes** the message and determines if tools are needed
4. **Tool execution** happens if needed (safely with approval prompts)
5. **Results are passed** back to the AI for further processing
6. **Final response** is displayed to the user
7. **Session is saved** with all messages and events

## API Compatibility

Available providers (provider/model format):

- `anthropic/claude-sonnet-4-6`
- `anthropic/claude-3-5-sonnet-2024-22-16`
- `openai/gpt-4`
- `openai/gpt-3.5-turbo`

## Configuration

Session data is stored in the `.coding-agent/` directory in your working directory:

```
.coding-agent/
├── events/          # Individual event logs
│   └── <session-id>/
└── sessions/        # Session metadata
    └── <session-id>
```

## Development

```bash
# Run development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Safety Considerations

- All shell commands require explicit approval before execution
- Tool results are previewed before being shown to the AI
- File modifications can be reviewed via event logs
- Maximum iteration limit prevents infinite loops (default: 50)

## License

MIT

## Contributing

Contributions are welcome! Feel free to submit issues and pull requests.