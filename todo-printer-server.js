require("dotenv").config();
const express = require("express");
const usb = require("usb");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Jimp = require("jimp");
const {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
} = require("node-thermal-printer");

const LOGOS_DIR = path.join(__dirname, "logos");
// Standard 80mm ESC/POS paper width in dots at 203 DPI
const PAPER_WIDTH = 576;
const HEADER_HEIGHT = 96;

function getRandomLogoPath() {
  const files = fs.readdirSync(LOGOS_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f));
  if (files.length === 0) return null;
  return path.join(LOGOS_DIR, files[Math.floor(Math.random() * files.length)]);
}

async function buildHeaderImage(logoPath, labelText) {
  const logo = await Jimp.read(logoPath);
  logo.resize(Jimp.AUTO, HEADER_HEIGHT);
  const logoWidth = logo.getWidth();

  // White base canvas
  const header = new Jimp(PAPER_WIDTH, HEADER_HEIGHT, 0xffffffff);
  header.composite(logo, 0, 0);

  // Black panel for "TODO" label, starting right after the logo with a small gap
  const panelX = logoWidth + 8;
  const panelWidth = PAPER_WIDTH - panelX;
  const panel = new Jimp(panelWidth, HEADER_HEIGHT, 0x000000ff);
  header.composite(panel, panelX, 0);

  // Print the label in white centered inside the black panel
  const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const label = ` ${labelText} `;
  const textW = Jimp.measureText(font, label);
  const textH = Jimp.measureTextHeight(font, label, panelWidth);
  const textX = panelX + Math.max(0, Math.floor((panelWidth - textW) / 2));
  const textY = Math.max(0, Math.floor((HEADER_HEIGHT - textH) / 2));
  header.print(font, textX, textY, label);

  return header.getBufferAsync(Jimp.MIME_PNG);
}

// Printer configuration
const PRINTER_TYPE = process.env.PRINTER_TYPE || "EPSON";

// Check if network or USB mode
const useNetworkPrinter = !!process.env.PRINTER_NETWORK_IP;

// USB configuration
let VENDOR_ID, PRODUCT_ID;
if (!useNetworkPrinter) {
  if (!process.env.PRINTER_VENDOR_ID || !process.env.PRINTER_PRODUCT_ID) {
    throw new Error(
      "For USB mode: PRINTER_VENDOR_ID and PRINTER_PRODUCT_ID environment variables are required. " +
        "For network mode: Set PRINTER_NETWORK_IP instead."
    );
  }
  VENDOR_ID = parseInt(process.env.PRINTER_VENDOR_ID, 16);
  PRODUCT_ID = parseInt(process.env.PRINTER_PRODUCT_ID, 16);
}

// Network configuration
const NETWORK_IP = process.env.PRINTER_NETWORK_IP;
const NETWORK_PORT = process.env.PRINTER_NETWORK_PORT || "9100";

class TodoPrinter {
  constructor() {
    this.printer = null;
  }

  async connect() {
    try {
      if (useNetworkPrinter) {
        // Network printer connection
        console.log(
          `Attempting network connection to ${NETWORK_IP}:${NETWORK_PORT}`
        );

        this.printer = new ThermalPrinter({
          type: PrinterTypes[PRINTER_TYPE],
          interface: `tcp://${NETWORK_IP}:${NETWORK_PORT}`,
          characterSet: CharacterSet.PC852_LATIN2,
          removeSpecialCharacters: false,
          lineCharacter: "=",
        });
      } else {
        // USB printer connection
        const device = usb.findByIds(VENDOR_ID, PRODUCT_ID);

        if (!device) {
          console.log("USB device not found");
          return false;
        }

        console.log("USB device found, connecting...");
        this.printer = new ThermalPrinter({
          type: PrinterTypes[PRINTER_TYPE],
          interface: `usb://${VENDOR_ID.toString(16).padStart(
            4,
            "0"
          )}:${PRODUCT_ID.toString(16).padStart(4, "0")}`,
          characterSet: CharacterSet.PC852_LATIN2,
          removeSpecialCharacters: false,
          lineCharacter: "=",
        });
      }

      // Test connection
      const isConnected = await this.printer.isPrinterConnected();
      return isConnected;
    } catch (error) {
      console.error("Error initializing printer:", error.message);
      return false;
    }
  }

  async printTicket(
    title,
    assignee = null,
    description = null,
    { label = "TODO", ownerLabel = "OWNER" } = {}
  ) {
    if (!this.printer) {
      throw new Error("Printer not initialized");
    }

    try {
      // Clear buffer
      this.printer.clear();

      // Header: logo on the left, label on the right, composited into one image
      const logoPath = getRandomLogoPath();
      if (logoPath) {
        const headerImage = await buildHeaderImage(logoPath, label);
        this.printer.alignLeft();
        await this.printer.printImageBuffer(headerImage);
      } else {
        // Fallback when no logos are available
        this.printer.alignCenter();
        this.printer.setTextSize(2, 2);
        this.printer.bold(true);
        this.printer.invert(true);
        this.printer.println(` ${label} `);
        this.printer.invert(false);
        this.printer.bold(false);
        this.printer.setTextNormal();
      }

      // Task title section
      this.printer.alignLeft();
      this.printer.drawLine();

      // Title with large text
      this.printer.setTextSize(1, 2);
      this.printer.bold(true);
      const wrappedTitle = this.wrapText(title, 24);
      wrappedTitle.split("\n").forEach((line) => {
        this.printer.println(line);
      });
      this.printer.bold(false);
      this.printer.setTextNormal();
      this.printer.newLine();

      // Assignee section with highlight, at normal size like the notes
      if (assignee && assignee.trim()) {
        this.printer.bold(true);
        this.printer.print(`${ownerLabel}: `);
        this.printer.bold(false);
        this.printer.underline(true);
        this.printer.println(assignee.trim());
        this.printer.underline(false);
        this.printer.newLine();
      }

      // Description section with indentation
      if (description && description.trim()) {
        this.printer.bold(true);
        this.printer.println("NOTES:");
        this.printer.bold(false);

        // Indent and wrap description
        const wrappedDesc = this.wrapText(description.trim(), 46); // 48 columns at normal size, minus "> " prefix
        wrappedDesc.split("\n").forEach((line) => {
          this.printer.println(`> ${line}`);
        });
        this.printer.newLine();
      }

      // Timestamp
      this.printer.alignCenter();
      this.printer.setTextSize(1, 1);
      // Round to nearest hour (9:31 -> 10a, 9:29 -> 9a, 23:45 -> 12a next day)
      const rounded = new Date(Date.now() + 30 * 60 * 1000);
      const hour = rounded.getHours();
      const hour12 = hour % 12 || 12;
      const ampm = hour < 12 ? "a" : "p";

      const timestamp = `${hour12}${ampm} ${rounded.toLocaleDateString("en-US", {
        weekday: "short",
      })} - ${rounded.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })}`;
      this.printer.println(timestamp);
      this.printer.setTextNormal();
      this.printer.alignLeft();

      // Cut paper
      this.printer.cut();

      // Execute print job
      await this.printer.execute();

      console.log("✅ Ticket printed successfully");
    } catch (error) {
      throw new Error(`Print error: ${error.message}`);
    }
  }

  // Simple word-wrap function; keeps the line breaks already in the text
  wrapText(text, width) {
    const lines = [];

    for (const paragraph of text.split(/\r?\n/)) {
      let currentLine = "";

      for (const word of paragraph.split(" ")) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;

        if (testLine.length <= width) {
          currentLine = testLine;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      }

      lines.push(currentLine);
    }

    return lines.join("\n");
  }
}

// Create Express app
const app = express();
const port = 3000;

// Middleware
app.use(express.json());

// Initialize printer
const printer = new TodoPrinter();
let printerConnected = false;

// Printer work shares the printer's command buffer, so it runs one job at a time
let printQueue = Promise.resolve();
function inQueue(work) {
  const job = printQueue.then(work);
  printQueue = job.catch(() => {});
  return job;
}

// Checks the printer for real; connect() also gives a fresh printer object
function checkPrinter() {
  return inQueue(async () => (printerConnected = await printer.connect()));
}

// Connects on demand, so a printer that was off at startup or went away recovers.
// Resolves to false when the printer can't be reached.
function queuePrint(...ticketArgs) {
  return inQueue(async () => {
    if (!printerConnected) printerConnected = await printer.connect();
    if (!printerConnected) return false;
    try {
      await printer.printTicket(...ticketArgs);
      return true;
    } catch (error) {
      printerConnected = false;
      throw error;
    }
  });
}

const MAX_TITLE_LENGTH = 120;
const MAX_TEXT_LENGTH = 800;

// Returns an error message for invalid ticket text, or null when it is fine
function textError(title, ...texts) {
  if (!title || typeof title !== "string" || title.trim() === "") {
    return "Title is required and must be a non-empty string";
  }
  if (title.trim().length > MAX_TITLE_LENGTH) {
    return `Title must be at most ${MAX_TITLE_LENGTH} characters`;
  }
  if (texts.some((text) => text && String(text).trim().length > MAX_TEXT_LENGTH)) {
    return `Other fields must be at most ${MAX_TEXT_LENGTH} characters`;
  }
  return null;
}

// Start server first, then connect to printer
if (require.main === module) app.listen(port, () => {
  console.log(
    `📋 Todo Ticket Printer Server running on http://localhost:${port}`
  );
  console.log(`📄 Visit http://localhost:${port} for API documentation`);

  // Connect to printer after server starts, in the queue so no print runs meanwhile
  console.log("🔌 Connecting to printer...");
  checkPrinter().then((connected) => {
    if (connected) {
      console.log("🖨️  Printer status: Connected ✅");
    } else {
      console.log("🖨️  Printer status: Not connected ❌");
      console.log(
        "    Make sure the printer is powered on and connected via USB or network"
      );
    }
  });
});

// Health check endpoint
app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    printer: (await checkPrinter()) ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

// Print todo ticket endpoint
app.post("/print-todo", async (req, res) => {
  try {
    const { title, assignee, description } = req.body ?? {};

    const error = textError(title, assignee, description);
    if (error) {
      return res.status(400).json({ error });
    }

    // Print the ticket
    const printed = await queuePrint(
      title.trim(),
      assignee ? String(assignee).trim() : null,
      description ? String(description).trim() : null
    );
    if (!printed) {
      return res.status(503).json({
        error: "Printer is not connected",
      });
    }

    res.json({
      success: true,
      message: "Todo ticket printed successfully",
      ticket: {
        title: title.trim(),
        assignee: assignee ? String(assignee).trim() : null,
        description: description ? String(description).trim() : null,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Print error:", error);
    res.status(500).json({
      error: "Failed to print ticket",
      details: error.message,
    });
  }
});

// Message printing, intended for automated clients (AI agents, hooks, scripts)
const MESSAGE_KINDS = { note: "NOTE", alert: "ALERT", done: "DONE" };
const MESSAGE_RATE_LIMIT = parseInt(process.env.MESSAGE_RATE_LIMIT || "10", 10); // per hour
// Named tokens, one per group of machines (PRINT_API_TOKENS=home:abc,external:def),
// so a group can be cut off without touching the others. A single PRINT_API_TOKEN
// still works and is named "default".
const API_TOKENS = (process.env.PRINT_API_TOKENS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf(":");
    const name = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (separator < 1 || !token) {
      throw new Error(`PRINT_API_TOKENS entries must look like name:token, got "${entry}"`);
    }
    return { name, expected: Buffer.from(`Bearer ${token}`) };
  });
if (process.env.PRINT_API_TOKEN) {
  API_TOKENS.push({
    name: "default",
    expected: Buffer.from(`Bearer ${process.env.PRINT_API_TOKEN}`),
  });
}
const recentMessageTimes = [];

function requireToken(req, res, next) {
  if (API_TOKENS.length === 0) {
    return res.status(503).json({
      error: "No API tokens are configured on the server (PRINT_API_TOKENS)",
    });
  }
  const provided = Buffer.from(req.get("Authorization") || "");
  const match = API_TOKENS.find(
    ({ expected }) =>
      provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected)
  );
  if (!match) {
    return res.status(401).json({ error: "Invalid or missing bearer token" });
  }
  req.tokenName = match.name;
  next();
}

app.post("/print-message", requireToken, async (req, res) => {
  try {
    const { kind = "note", title, body, source } = req.body ?? {};

    if (!MESSAGE_KINDS[kind]) {
      return res.status(400).json({
        error: `kind must be one of: ${Object.keys(MESSAGE_KINDS).join(", ")}`,
      });
    }
    const error = textError(title, body, source);
    if (error) {
      return res.status(400).json({ error });
    }

    const hourAgo = Date.now() - 60 * 60 * 1000;
    while (recentMessageTimes.length && recentMessageTimes[0] < hourAgo) {
      recentMessageTimes.shift();
    }
    if (recentMessageTimes.length >= MESSAGE_RATE_LIMIT) {
      return res.status(429).json({
        error: `Rate limit reached (${MESSAGE_RATE_LIMIT} messages per hour)`,
      });
    }

    // Count the message before printing so parallel requests can't exceed the limit,
    // and give the slot back if nothing was printed
    const sentAt = Date.now();
    recentMessageTimes.push(sentAt);
    const giveBackSlot = () =>
      recentMessageTimes.splice(recentMessageTimes.indexOf(sentAt), 1);
    // The token's group is printed with the sender, since clients pick their own source
    const from = source ? `${String(source).trim()} (${req.tokenName})` : req.tokenName;
    const printed = await queuePrint(
      title.trim(),
      from,
      body ? String(body).trim() : null,
      { label: MESSAGE_KINDS[kind], ownerLabel: "FROM" }
    ).catch((error) => {
      giveBackSlot();
      throw error;
    });
    if (!printed) {
      giveBackSlot();
      return res.status(503).json({
        error: "Printer is not connected",
      });
    }

    res.json({
      success: true,
      message: "Message printed successfully",
      printed: {
        kind,
        title: title.trim(),
        from,
        body: body ? String(body).trim() : null,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Print error:", error);
    res.status(500).json({
      error: "Failed to print message",
      details: error.message,
    });
  }
});

// Get printer status
app.get("/printer-status", async (req, res) => {
  const status = {
    connected: await checkPrinter(),
    type: PRINTER_TYPE,
    mode: useNetworkPrinter ? "network" : "usb",
  };

  if (useNetworkPrinter) {
    status.interface = `tcp://${NETWORK_IP}:${NETWORK_PORT}`;
    status.network_ip = NETWORK_IP;
    status.network_port = NETWORK_PORT;
  } else {
    status.interface = `usb://${VENDOR_ID.toString(16).padStart(
      4,
      "0"
    )}:${PRODUCT_ID.toString(16).padStart(4, "0")}`;
    status.vendor_id = `0x${VENDOR_ID.toString(16)}`;
    status.product_id = `0x${PRODUCT_ID.toString(16)}`;
  }

  res.json(status);
});

// Basic usage info endpoint
app.get("/", (req, res) => {
  res.json({
    name: "Todo Ticket Printer Server",
    version: "1.0.0",
    endpoints: {
      "GET /": "This help message",
      "GET /health": "Health check",
      "GET /printer-status": "Printer connection status",
      "POST /print-todo": "Print a todo ticket",
      "POST /print-message":
        "Print a note/alert/done message (requires bearer token)",
    },
    usage: {
      "POST /print-todo": {
        body: {
          title: "string (required) - The main task title",
          assignee: "string (optional) - Person assigned to the task",
          description: "string (optional) - Additional task details",
        },
      },
      "POST /print-message": {
        headers: { Authorization: "Bearer <token from PRINT_API_TOKENS>" },
        body: {
          kind: "string (optional) - note (default), alert or done",
          title: `string (required) - Headline, max ${MAX_TITLE_LENGTH} chars`,
          body: `string (optional) - Message text, max ${MAX_TEXT_LENGTH} chars`,
          source: "string (optional) - Who sent it, e.g. Claude Code",
        },
      },
    },
    example: {
      title: "Fix the login bug",
      assignee: "John Doe",
      description:
        "Users are unable to login with special characters in their passwords",
    },
  });
});

module.exports = app;
