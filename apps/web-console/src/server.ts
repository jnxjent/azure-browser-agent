import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const indexPath = new URL("../public/index.html", import.meta.url);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" || !["/", "/index.html"].includes(request.url ?? "")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const html = await readFile(indexPath);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src http://127.0.0.1:3001 http://localhost:3001",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(html);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Unable to load Web Console: ${message}`);
  }
});

const port = parsePort(process.env.WEB_CONSOLE_PORT, 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`Web Console listening on http://127.0.0.1:${port}`);
});

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}
