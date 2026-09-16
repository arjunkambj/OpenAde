import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { site } from "../src/site";

const DIST = join(import.meta.dirname, "..", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

let server: Server;
let origin: string;

const get = async (path: string) => fetch(`${origin}${path}`);

beforeAll(async () => {
  if (!existsSync(DIST)) {
    throw new Error("apps/site/dist is missing; the test script runs `vite build` first");
  }
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
    const file = join(DIST, relative);
    if (!file.startsWith(DIST) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("smoke server did not bind a port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("built site", () => {
  it("serves index.html with the product name", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toContain(site.name);
  });

  it("serves every asset the page references", async () => {
    const html = await (await get("/")).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const response = await get(asset);
      expect(response.status, `${asset} should serve`).toBe(200);
    }
  });

  it("renders download and feedback links as absolute https URLs", async () => {
    const html = await (await get("/")).text();
    for (const url of [site.downloadUrl, site.feedbackUrl]) {
      expect(html, `${url} should be linked`).toContain(url);
      expect(new URL(url).protocol).toBe("https:");
    }
  });

  it("nav anchors land on real sections", async () => {
    const html = await (await get("/")).text();
    for (const anchor of ["features", "get-started", "download", "feedback"]) {
      expect(html, `#${anchor} should have a target`).toContain(`id="${anchor}"`);
    }
  });

  it("serves robots.txt, sitemap.xml and 404.html", async () => {
    for (const path of ["/robots.txt", "/sitemap.xml", "/404.html"]) {
      const response = await get(path);
      expect(response.status, `${path} should serve`).toBe(200);
    }
    expect(await (await get("/sitemap.xml")).text()).toContain("getopenade.com");
  });
});
