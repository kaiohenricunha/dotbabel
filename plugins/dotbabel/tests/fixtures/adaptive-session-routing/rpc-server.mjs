/** A subprocess protocol fixture. It never starts a model or performs a tool action. */
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let approval;
let initialized = 0;
const counts = new Map();
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (typeof message.method === "string") counts.set(message.method, (counts.get(message.method) ?? 0) + 1);
  if (message.method === "initialized") initialized += 1;
  else if (message.method === "initializationCount") send({ id: message.id, result: initialized });
  else if (message.method === "requestCount") send({ id: message.id, result: counts.get(message.params.method) ?? 0 });
  else if (message.method === "echo") send({ id: message.id, result: message.params });
  else if (message.method === "notify") { send({ method: "turn/completed", params: message.params }); send({ id: message.id, result: true }); }
  else if (message.method === "approval") { approval = message.id; send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: message.params }); }
  else if (message.id === "approval-1") send({ id: approval, result: message.error ? { errorCode: message.error.code } : message.result });
  else if (message.method === "reject") send({ id: message.id, error: { code: -32602, message: "private native error" } });
  else if (message.method === "raw") send(message.params);
  else if (message.method === "missingResult") send({ id: message.id });
  else if (message.method === "chunked") {
    const bytes = Buffer.from(JSON.stringify({ id: message.id, result: message.params }) + "\n");
    const split = bytes.indexOf(Buffer.from("🔍")) + 2;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
  }
  else if (message.method === "sized") {
    const overhead = Buffer.byteLength(JSON.stringify({ id: message.id, result: "" }));
    send({ id: message.id, result: "x".repeat(message.params.size - overhead) });
  }
  else if (message.method === "rejectUnknownCode") send({ id: message.id, error: { code: "private error code", message: "private error detail" } });
  else if (message.method === "unmatched") { send({ id: "unknown-id", result: "untrusted" }); send({ id: message.id, result: message.params }); }
  else if (message.method === "exit") process.exit(0);
  else if (message.method === "malformed") process.stdout.write("not-json\n");
  else if (message.method === "oversized") process.stdout.write("x".repeat(4096));
});
