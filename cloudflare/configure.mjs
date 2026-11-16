import { writeFileSync } from "node:fs";

const [id] = process.argv.slice(2);
if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id ?? "")) {
  console.error("Usage: node cloudflare/configure.mjs <D1 database ID>");
  process.exit(1);
}

const config = {
  name: "haru-diary",
  main: "worker.mjs",
  compatibility_date: "2026-10-01",
  workers_dev: true,
  preview_urls: false,
  assets: { directory: "../docs", binding: "ASSETS", run_worker_first: true },
  d1_databases: [{ binding: "DB", database_name: "haru-diary", database_id: id }]
};
writeFileSync(new URL("./wrangler.jsonc", import.meta.url), JSON.stringify(config, null, 2) + "\n");
console.log("Configured cloudflare/wrangler.jsonc");
