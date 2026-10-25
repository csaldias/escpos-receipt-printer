// Runs the server against a fake network printer: a local TCP socket that records each print job.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const jobs = [];
let fakePrinter;
let printerPort;
let server;
let baseUrl;

function startFakePrinter() {
  fakePrinter = net.createServer((socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => {
      // Connection checks send nothing, so only keep real jobs
      if (chunks.length) jobs.push(Buffer.concat(chunks).toString("latin1"));
    });
  });
  return new Promise((resolve) => fakePrinter.listen(printerPort, "127.0.0.1", resolve));
}

// The printer library hangs up right after writing, so jobs arrive a moment after the response
async function waitForJobs(count) {
  for (let i = 0; i < 50 && jobs.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.strictEqual(jobs.length, count);
}

function post(path, body, token = "test-token") {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  // Reserve a free port for the printer, but leave it closed so it starts "off"
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  printerPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  process.env.PRINTER_NETWORK_IP = "127.0.0.1";
  process.env.PRINTER_NETWORK_PORT = String(printerPort);
  process.env.PRINT_API_TOKENS = "home:test-token, external:external-token";
  process.env.MESSAGE_RATE_LIMIT = "3"; // test 4 and test 5 print 1 + 2
  const app = require("../todo-printer-server.js");
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  if (fakePrinter.listening) fakePrinter.close();
});

async function healthPrinter() {
  return (await (await fetch(`${baseUrl}/health`)).json()).printer;
}

test("printer off returns 503, and printing works once it comes on", async () => {
  assert.strictEqual(await healthPrinter(), "disconnected");
  const off = await post("/print-todo", { title: "Too early" });
  assert.strictEqual(off.status, 503);

  await startFakePrinter();
  assert.strictEqual(await healthPrinter(), "connected");
  const on = await post("/print-todo", { title: "Printer is back" });
  assert.strictEqual(on.status, 200);
  await waitForJobs(1);
  assert.match(jobs[0], /Printer is back/);
});

test("prints sent at the same time come out as separate tickets", async () => {
  jobs.length = 0;
  const responses = await Promise.all([
    post("/print-todo", { title: "First ticket" }),
    post("/print-todo", { title: "Second ticket" }),
  ]);
  responses.forEach((res) => assert.strictEqual(res.status, 200));
  await waitForJobs(2);
  for (const job of jobs) {
    assert.strictEqual(/First ticket/.test(job) + /Second ticket/.test(job), 1);
  }
});

test("rejects bad input on /print-todo", async () => {
  assert.strictEqual((await post("/print-todo", {})).status, 400);
  const long = await post("/print-todo", { title: "x", description: "a".repeat(801) });
  assert.strictEqual(long.status, 400);
  const noJson = await fetch(`${baseUrl}/print-todo`, { method: "POST", body: "title=x" });
  assert.strictEqual(noJson.status, 400);
});

test("/print-message needs one of the tokens, and prints its group", async () => {
  assert.strictEqual((await post("/print-message", { title: "x" }, null)).status, 401);
  assert.strictEqual((await post("/print-message", { title: "x" }, "wrong")).status, 401);
  assert.strictEqual((await post("/print-message", { title: "x" }, "home:test-token")).status, 401);

  jobs.length = 0;
  const res = await post("/print-message", { title: "From afar", source: "Claude Code" }, "external-token");
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).printed.from, "Claude Code (external)");
  await waitForJobs(1);
  assert.match(jobs[0], /Claude Code \(external\)/);
});

test("/print-message wraps each line on its own and enforces the rate limit", async () => {
  jobs.length = 0;
  // 45 characters after the line break still fit on one 46-character line
  const body = `a\n${"b".repeat(22)} ${"c".repeat(22)}`;
  const first = await post("/print-message", { kind: "alert", title: "Hi", body });
  assert.strictEqual(first.status, 200);
  await waitForJobs(1);
  assert.match(jobs[0], /> a\n/);
  assert.match(jobs[0], new RegExp(`> ${"b".repeat(22)} ${"c".repeat(22)}`));
  // FROM line and notes print at normal size: the last size command before FROM
  // is the reset after the big title (ESC ! 0), and none follows until the notes
  const beforeFrom = jobs[0].slice(0, jobs[0].indexOf("FROM"));
  assert.ok(beforeFrom.lastIndexOf("\x1b!\x00") > beforeFrom.lastIndexOf("\x1d!"));
  const fromToNotes = jobs[0].slice(jobs[0].indexOf("FROM"), jobs[0].indexOf("> a"));
  assert.doesNotMatch(fromToNotes, /\x1d!/);

  assert.strictEqual((await post("/print-message", { title: "Second" })).status, 200);
  assert.strictEqual((await post("/print-message", { title: "Third" })).status, 429);
});

test("/health notices when the printer goes away", async () => {
  await new Promise((resolve) => fakePrinter.close(resolve));
  assert.strictEqual(await healthPrinter(), "disconnected");
});
