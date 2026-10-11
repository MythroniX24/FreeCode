# Installation Guide

## Quick Install (Termux/Android)

### Method 1: Global Installation (Recommended)

```bash
# Navigate to the project
cd /storage/emulated/0/Projects/FreeCode

# Install dependencies
npm install

# Build all packages
npm run build

# Link the CLI globally
cd packages/cli
npm link
cd ../..

# Now you can use freecode from anywhere!
freecode run "Write a hello world in TypeScript"
```

### Method 2: Using the Install Script

```bash
# Run the installation script
node scripts/install.mjs

# This will:
# 1. Install dependencies
# 2. Build all packages
# 3. Link the CLI globally

# Then use it:
freecode run "Your prompt here"
```

### Method 3: Local Testing (No Global Install)

```bash
# Build the project
npm run build

# Run directly using node
node packages/cli/dist/index.js run "Your prompt"

# Or use npx (if packages/cli is linked)
npx freecode run "Your prompt"
```

---

## Using npm link

`npm link` creates a symlink from the global node_modules to your local package.

```bash
# In the CLI package directory
cd packages/cli
npm link

# This makes the `freecode` command available globally
freecode --version
```

To unlink:

```bash
npm unlink -g freecode
```

---

## Using pnpm (Alternative)

If you're using pnpm:

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Link globally
pnpm link --global packages/cli

# Use it
freecode run "Your prompt"
```

---

## Setting Up API Keys

FreeCode needs API keys to work. Set them as environment variables:

```bash
# Anthropic (recommended)
export ANTHROPIC_API_KEY="sk-..."

# Google
export GOOGLE_AI_API_KEY="AIza..."

# OpenRouter
export OPENROUTER_API_KEY="sk-or-..."

# Groq
export GROQ_API_KEY="gsk-..."
```

**Important:** Add these to your `~/.bashrc` or `~/.zshrc` so they persist:

```bash
echo 'export ANTHROPIC_API_KEY="sk-..."' >> ~/.bashrc
source ~/.bashrc
```

---

## Testing the Installation

```bash
# Check version
freecode --version

# Run the doctor command to check setup
freecode doctor

# Try a simple prompt
freecode run "What is 2+2?"
```

---

## Troubleshooting

### "Command not found: freecode"

The global link didn't work. Try:

```bash
# Check where npm installs global packages
npm root -g

# Manually add to PATH if needed
export PATH="$(npm root -g)/../bin:$PATH"
```

### "Cannot find module '@freecode/core'"

The core package needs to be built first:

```bash
npm run build
```

### Permission denied

On Termux, you might need to use `termux-setup-storage` first:

```bash
termux-setup-storage
```

---

## Updating

To update to the latest version:

```bash
cd /storage/emulated/0/Projects/FreeCode
git pull
npm install
npm run build
cd packages/cli
npm link
```

---

## See Also

- [README.md](README.md) - Main documentation
- [docs/usage.md](docs/basic-usage.md) - Usage examples
