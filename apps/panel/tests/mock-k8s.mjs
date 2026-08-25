// Mock Kubernetes API for local panel testing (never deployed).
import { createServer } from "node:http";

const jobs = { items: [{ metadata: { name: "panel-x", creationTimestamp: new Date().toISOString() }, status: { active: 1 } }] };
const cronjobs = { items: [{ metadata: { name: "loop-example" }, spec: { schedule: "0 9 * * *" }, status: {} }] };

createServer((req, res) => {
  if (req.method === "POST" && req.url.includes("/jobs")) {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b);
      j.metadata.creationTimestamp = new Date().toISOString();
      j.status = { active: 1 };
      jobs.items.push(j);
      console.log("[mock] created job", j.metadata.name);
      res.writeHead(201).end(b);
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify(req.url.includes("cronjobs") ? cronjobs : jobs),
  );
}).listen(process.env.MOCK_PORT ?? 3930, () => console.log("[mock] up"));
