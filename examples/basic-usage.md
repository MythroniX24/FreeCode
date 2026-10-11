# Basic Usage Examples

This directory contains examples demonstrating how to use FreeCode in various scenarios.

---

## Quick Start

### 1. Install and Build

```bash
# Clone the repository
git clone <repository-url> freecode
cd freecode

# Install dependencies
npm install

# Build all packages
npm run build

# Link the CLI (optional)
npx npm link --workspace packages/cli
```

### 2. Set Up Your API Key

FreeCode supports multiple providers. Set your API key as an environment variable:

```bash
# Anthropic
export ANTHROPIC_API_KEY="sk-..."

# Google
export GOOGLE_AI_API_KEY="AIza..."

# OpenRouter
export OPENROUTER_API_KEY="sk-or-..."

# Groq
export GROQ_API_KEY="gsk-..."
```

**Important:** Never put API keys in configuration files or command-line arguments.

---

## Example 1: Simple Code Generation

Generate code from a natural language prompt:

```bash
freecode run "Write a TypeScript function that implements binary search"
```

This will:

1. Use your default provider (or prompt you to select one)
2. Send the prompt to the LLM
3. Execute any tools the agent requests (if approved)
4. Return the generated code

---

## Example 2: Use a Specific Provider

```bash
freecode run --provider anthropic "Explain how to use React hooks"
```

Supported providers: `anthropic`, `google`, `openrouter`, `groq`, `ollama`

---

## Example 3: Use a Specific Model

```bash
freecode run --model claude-3-sonnet-20241022 "Write a test suite for this function"
```

---

## Example 4: Run with a Budget

Limit the number of tokens the agent can use:

```bash
freecode run --max-tokens 1000 "Write a short poem about programming"
```

---

## Example 5: Interactive Mode

Run the agent in interactive mode to approve each tool call:

```bash
freecode run --interactive "Refactor this module"
```

---

## Example 6: Use the Hosted Gateway

If you have a hosted gateway running:

```bash
freecode run \
  --gateway-url http://localhost:8787 \
  --gateway-key your-api-key \
  "Implement a REST API endpoint"
```

---

## Example 7: Configuration Management

View your current configuration:

```bash
freecode config show
```

Set a configuration value:

```bash
freecode config set defaultProvider anthropic
```

**Note:** Credentials are never stored in configuration. They must be set as environment variables.

---

## Example 8: Diagnose Environment

Check your environment and configuration for issues:

```bash
freecode doctor
```

This will:

- Check Node.js version
- Check for required environment variables
- Validate configuration files
- Test provider connectivity

---

## Example 9: Start the Gateway

Start the hosted gateway server:

```bash
freecode gateway:start
```

Or in development mode (with hot reload):

```bash
freecode gateway:dev
```

---

## Example 10: Use with a Configuration File

Create a `.freecode.json` configuration file:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-3-sonnet-20241022",
  "maxTokens": 4000,
  "temperature": 0.7
}
```

Then run:

```bash
freecode run "Write a comprehensive test suite"
```

---

## Example 11: Batch Processing

Process multiple prompts in sequence:

```bash
freecode run "Write a README for this project"
freecode run "Add a contributing section to the README"
freecode run "Create a CHANGELOG entry"
```

---

## Example 12: Use with Files

The agent can read and write files:

```bash
# Ask the agent to analyze a file
freecode run "Analyze the code in src/index.ts and suggest improvements"

# Ask the agent to create a new file
freecode run "Create a new utility function in src/utils.ts"
```

**Note:** File operations are confined by `PathGuard` for security.

---

## Example 13: Web Search

The agent can search the web for information:

```bash
freecode run "What are the latest best practices for React performance optimization?"
```

---

## Example 14: Use Tools Directly

The agent has access to multiple tools:

| Tool      | Description                 |
| --------- | --------------------------- |
| Bash      | Run shell commands          |
| Read      | Read file contents          |
| Write     | Write to files              |
| Edit      | Edit existing files         |
| WebFetch  | Fetch web content           |
| WebSearch | Search the web              |
| Artifact  | Create and manage artifacts |

Example prompting for specific tools:

```bash
# Use bash to check the Node version
freecode run "What version of Node.js am I running? Use the Bash tool."

# Read a file and explain it
freecode run "Read package.json and explain the scripts section"

# Search for documentation
freecode run "Use WebSearch to find the TypeScript 5.0 release notes"
```

---

## Example 15: Gateway Configuration

Configure the gateway with environment variables:

```bash
# Server settings
export GATEWAY_HOST=127.0.0.1
export GATEWAY_PORT=8787
export GATEWAY_LOG_LEVEL=info

# API keys (comma-separated)
export GATEWAY_API_KEYS="key1,key2,key3"

# Quota limits
export GATEWAY_REQUESTS_PER_MINUTE=60
export GATEWAY_REQUESTS_PER_DAY=2000
export GATEWAY_INPUT_TOKENS_PER_DAY=2000000
export GATEWAY_OUTPUT_TOKENS_PER_DAY=500000

# Concurrency
export GATEWAY_MAX_CONCURRENT_REQUESTS=4

# Providers
export GATEWAY_PROVIDERS='{"anthropic":{"enabled":true,"type":"anthropic","models":["claude-3-sonnet-20241022"]}}'

# Database
export DATABASE_URL="postgres://user:pass@localhost:5432/freecode"

# Start the gateway
freecode gateway:start
```

---

## Example 16: Use with OpenAI-Compatible Clients

The gateway exposes an OpenAI-compatible API, so you can use any OpenAI client:

```python
# Python example using openai package
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key="your-gateway-key"
)

response = client.chat.completions.create(
    model="claude-3-sonnet-20241022",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

```javascript
// JavaScript example
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:8787/v1',
  apiKey: 'your-gateway-key',
});

const response = await openai.chat.completions.create({
  model: 'claude-3-sonnet-20241022',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

---

## Example 17: Streaming Responses

Get streaming responses from the gateway:

```bash
# The gateway supports SSE streaming
curl -N -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[{"role":"user","content":"Tell me a story"}],"stream":true}' \
  http://localhost:8787/v1/chat/completions
```

---

## Example 18: Check Gateway Health

```bash
curl http://localhost:8787/health
```

---

## Example 19: List Available Models

```bash
curl -H "Authorization: Bearer your-key" http://localhost:8787/v1/models
```

---

## Example 20: Check Usage

```bash
curl -H "Authorization: Bearer your-key" http://localhost:8787/v1/usage
```

---

## Troubleshooting

### "No provider configured"

Set your API key as an environment variable:

```bash
export ANTHROPIC_API_KEY="sk-..."
```

### "Model not found"

Check the available models for your provider:

```bash
freecode doctor
```

### "Permission denied"

Ensure you have read/write permissions for the files you're working with.

### "Quota exceeded"

If using the gateway, check your quota limits. For BYOK mode, check your provider's limits.

---

## See Also

- [README](../README.md) — Main documentation
- [Security](../docs/security.md) — Security constraints
- [Testing](../docs/testing.md) — Testing strategy
