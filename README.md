# Todo Ticket Printer Server

Node.js application for printing TODO tickets on thermal receipt printers.

## Features

- 🎫 Print todo tickets with title, assignee, and description
- 🔔 Token-protected message endpoint for automated clients (AI agents, hooks, scripts)
- 🖼️ Random logo from `logos/` printed in the ticket header
- 🖨️ Support for USB and network thermal printers
- 📋 RESTful API endpoints
- 🐳 Docker support (recommended for network printers)
- 📱 Easy to integrate with other applications

## Quick Start

### Docker (Recommended for Network Printers, USB on Linux only)

1. **Configure your printer:**

   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` for your printer:**

   **For Network Printer (recommended):**

   ```bash
   PRINTER_NETWORK_IP=10.0.0.237  # Your printer's IP
   PRINTER_NETWORK_PORT=9100      # Usually 9100
   ```

   **For USB Printer (Linux only):**

   ```bash
   # Find your printer's USB IDs with: lsusb
   PRINTER_VENDOR_ID=0x20d1
   PRINTER_PRODUCT_ID=0x7008
   ```

3. **Run with Docker Compose:**

   ```bash
   docker-compose up -d
   ```

   This builds the image locally. A prebuilt multi-arch image (amd64/arm64) is also published to GitHub Packages on every push to `main` and every `v*` tag:

   ```bash
   docker pull ghcr.io/csaldias/escpos-receipt-printer:latest
   ```

4. **Test the API:**
   ```bash
   curl -X POST http://localhost:3000/print-todo \
     -H "Content-Type: application/json" \
     -d '{
       "title": "Test the printer setup",
       "assignee": "John Doe",
       "description": "Make sure the printer is working correctly"
     }'
   ```

### Local Development

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Configure environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your printer settings
   ```

3. **Run the server:**
   ```bash
   npm run todo-server
   ```

4. **Run the tests** (they use a fake printer, nothing is printed):
   ```bash
   npm test
   ```

## API Endpoints

### POST /print-todo

Print a TODO ticket. Requests must be JSON (`Content-Type: application/json`). Titles are limited to 120 characters, the other fields to 800.

**Request Body:**

```json
{
  "title": "Fix the login bug", // Required: Main task title
  "assignee": "John Doe", // Optional: Person assigned
  "description": "Users cannot login..." // Optional: Task details
}
```

**Response:**

```json
{
  "success": true,
  "message": "Todo ticket printed successfully",
  "ticket": {
    "title": "Fix the login bug",
    "assignee": "John Doe",
    "description": "Users cannot login...",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### POST /print-message

Print a short message for automated clients (AI agents, hooks, scripts). The header shows `NOTE`, `ALERT` or `DONE` instead of `TODO`.

Requires `Authorization: Bearer <PRINT_API_TOKEN>`. Same length limits as `/print-todo`, and the server prints at most `MESSAGE_RATE_LIMIT` messages per hour (default 10).

```bash
curl -X POST http://localhost:3000/print-message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRINT_API_TOKEN" \
  -d '{
    "kind": "alert",
    "title": "Need your input",
    "body": "The migration is waiting for you to pick a backup location.",
    "source": "Claude Code"
  }'
```

**Request Body:**

```json
{
  "kind": "note", // Optional: note (default), alert or done
  "title": "Build finished", // Required: headline
  "body": "All 214 tests passed.", // Optional: message text
  "source": "Claude Code" // Optional: printed as FROM
}
```

### GET /health

Check server and printer status.

### GET /printer-status

Get detailed printer connection information.

### GET /

API documentation and usage examples

## Configuration

Configure your printer in the `.env` file. Choose either USB or Network mode:

#### USB Mode

- `PRINTER_VENDOR_ID`: USB Vendor ID (hex format, e.g., `0x20d1`)
- `PRINTER_PRODUCT_ID`: USB Product ID (hex format, e.g., `0x7008`)

#### Network Mode

- `PRINTER_NETWORK_IP`: Network printer IP address
- `PRINTER_NETWORK_PORT`: Network printer port (default: 9100)

#### Logos

Each ticket header shows a random `.png`/`.jpg` from the `logos/` directory, scaled to 96px high. Add or remove files there to change the selection; with no logos, a plain text header is printed instead.

#### Message API

- `PRINT_API_TOKEN`: Bearer token required by `POST /print-message` (the endpoint is disabled when unset). Generate one with `openssl rand -hex 32`
- `MESSAGE_RATE_LIMIT`: Maximum messages printed per hour (default: 10)

## Examples

### Using curl

```bash
# Simple ticket with just a title
curl -X POST http://localhost:3000/print-todo \
  -H "Content-Type: application/json" \
  -d '{"title":"Review pull request #123"}'

# Full ticket with assignee and description
curl -X POST http://localhost:3000/print-todo \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix login bug",
    "assignee": "John Doe",
    "description": "Users are unable to login with special characters in their passwords"
  }'
```

### Using the test client

```bash
# Simple ticket
node test-client.js "Fix login bug"

# With assignee
node test-client.js "Fix login bug" "John Doe"

# Full ticket
node test-client.js "Fix login bug" "John Doe" "Users cannot login with special chars"
```

### Using JavaScript fetch

```javascript
const response = await fetch("http://localhost:3000/print-todo", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: "Update documentation",
    assignee: "Alice Smith",
    description: "Add API documentation for the new endpoints",
  }),
});

const result = await response.json();
console.log(result);
```

## Docker Notes

### Recommended: Network Mode

For best compatibility across all platforms, use network-connected printers:

1. Configure your printer for network access
2. Set `PRINTER_NETWORK_IP` in your `.env` file
3. Run with Docker: `docker-compose up -d`

### USB Mode Limitations

⚠️ **USB passthrough has platform-specific limitations:**

- **Linux**: Full USB support with privileged mode
- **macOS/Windows**: USB passthrough not supported with Docker Desktop due to virtualization

**For USB printers on macOS/Windows:**

1. Run natively: `npm run todo-server`
2. Use a Linux host for Docker deployment
3. Convert to network printer (recommended)

## Troubleshooting

### Printer Not Found

1. Ensure printer is powered on and connected
2. For USB: Check USB IDs with `lsusb`
3. For Network: Verify IP address is reachable
4. Check your `.env` configuration

### Print Quality

- Ensure printer has paper loaded
- Check paper width matches expectations

## Related Files

- `todo-printer-server.js` - Main server file
- `printer.js` - Simple print test utility
- `test-client.js` - Test client for trying the API
