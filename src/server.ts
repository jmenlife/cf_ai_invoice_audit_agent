import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import type { auditInvoice, ContractRates, Invoice } from "./audit";

// Cloudflare needs the Workflow exported from this main file.
export { InvoiceAuditWorkflow } from "./workflow";

type AuditResult = ReturnType<typeof auditInvoice>;

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD" });

const SYSTEM_PROMPT = `You are an invoice audit assistant for a freight team.
Use your tools. Never calculate a variance or state a rate from your own knowledge.
- When the user shares invoice text, call auditInvoice with the full text. The audit runs in the background and posts its result in the chat when it finishes, so do not guess at the outcome.
- For contract rates, call listContracts.
- For past audits or totals, call getAuditHistory.
- To add or change a carrier's rates, call listContracts first, then call saveContract with every rate. The user must approve the change.
Keep replies short.`;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Memory: a SQL table for carrier contract rates
    this.sql`CREATE TABLE IF NOT EXISTS contracts (
      carrier TEXT PRIMARY KEY COLLATE NOCASE,
      linehaul_per_mile REAL NOT NULL,
      fuel_surcharge_pct REAL NOT NULL,
      detention_per_hour REAL NOT NULL,
      detention_free_hours REAL NOT NULL,
      overweight_fee REAL NOT NULL,
      overweight_over_lbs REAL NOT NULL
    )`;

    // Sample contract so the app has rates on file. These are made up.
    this.sql`INSERT OR IGNORE INTO contracts VALUES
      ('Demo Carrier', 2.40, 18, 75, 2, 150, 44000)`;

    // Memory: a SQL table for finished audits
    this.sql`CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      invoice_number TEXT,
      carrier TEXT,
      billed_total REAL,
      expected_total REAL,
      overbilled REAL,
      underbilled REAL,
      details TEXT,
      created_at TEXT NOT NULL
    )`;

    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  // Starts a background audit and returns right away.
  async startAudit(invoiceText: string) {
    const auditId = crypto.randomUUID();
    this.sql`INSERT INTO audits (id, status, created_at)
      VALUES (${auditId}, 'running', ${new Date().toISOString()})`;
    await this.runWorkflow(
      "INVOICE_AUDIT_WORKFLOW",
      { auditId, invoiceText },
      { id: auditId }
    );
    return auditId;
  }

  // The Workflow calls this to read a carrier's rates.
  getContract(carrier: string) {
    const [contract] = this.sql<ContractRates>`
      SELECT * FROM contracts WHERE carrier = ${carrier}`;
    return contract ?? null;
  }

  // The Workflow calls this to save its result.
  finishAudit(auditId: string, invoice: Invoice, result: AuditResult | null) {
    this.sql`UPDATE audits SET
        status = ${result ? "complete" : "no_contract"},
        invoice_number = ${invoice.invoiceNumber},
        carrier = ${invoice.carrier},
        billed_total = ${result?.billedTotal ?? null},
        expected_total = ${result?.expectedTotal ?? null},
        overbilled = ${result?.overbilled ?? null},
        underbilled = ${result?.underbilled ?? null},
        details = ${result ? JSON.stringify(result) : null}
      WHERE id = ${auditId}`;
  }

  // Cloudflare calls this when a Workflow finishes.
  async onWorkflowComplete(_workflowName: string, workflowId: string) {
    await this.postAuditSummary(workflowId);
  }

  // Cloudflare calls this when a Workflow fails after its retries.
  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    this.sql`UPDATE audits SET status = 'failed' WHERE id = ${workflowId}`;
    await this.postChatMessage(
      `That audit failed after its retries: ${error}. No result was saved, so please try again.`
    );
  }

  // Code writes this summary, so the figures always match the saved audit.
  private async postAuditSummary(auditId: string) {
    const [audit] = this.sql<{
      invoice_number: string;
      carrier: string;
      details: string | null;
    }>`SELECT invoice_number, carrier, details FROM audits WHERE id = ${auditId}`;
    if (!audit) return;

    const label = `Invoice ${audit.invoice_number} from ${audit.carrier}`;

    if (!audit.details) {
      await this.postChatMessage(
        `${label} could not be audited because there are no contract rates on file for ${audit.carrier}.`
      );
      return;
    }

    const result = JSON.parse(audit.details) as AuditResult;
    const issues = result.findings
      .filter((f) => f.variance !== 0)
      .map(
        (f) =>
          `- **${f.item}:** billed ${money(f.billed)}, contract ${money(f.expected)}`
      );
    const warnings = result.warnings.map((w) => `- ${w}`);

    if (issues.length === 0 && warnings.length === 0) {
      await this.postChatMessage(
        `${label} matches the contract at ${money(result.billedTotal)}. Nothing to correct.`
      );
      return;
    }

    const totals = [
      result.overbilled > 0 ? `Overbilled by ${money(result.overbilled)}.` : "",
      result.underbilled > 0
        ? `Underbilled by ${money(result.underbilled)}.`
        : ""
    ].filter(Boolean);

    await this.postChatMessage(
      [
        `${label} was billed ${money(result.billedTotal)} against ${money(result.expectedTotal)} under contract. ${totals.join(" ")}`,
        "",
        ...issues,
        ...warnings
      ].join("\n")
    );
  }

  // Adds a message to the chat without asking the AI to write anything.
  private async postChatMessage(text: string) {
    const stable = await this.waitUntilStable({ timeout: 30_000 });
    if (!stable) return;
    await this.persistMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // Starts the Workflow that audits an invoice
        auditInvoice: tool({
          description:
            "Start a background audit of one carrier invoice against its contract rates.",
          inputSchema: z.object({
            invoiceText: z
              .string()
              .describe("The full invoice text exactly as the user shared it")
          }),
          execute: async ({ invoiceText }) => {
            await this.startAudit(invoiceText);
            return {
              status: "running",
              note: "The result will appear in the chat when the audit finishes."
            };
          }
        }),

        // Looks up contract rates from memory
        listContracts: tool({
          description: "List the contract rates on file for every carrier.",
          inputSchema: z.object({}),
          execute: async () => this.sql`SELECT * FROM contracts`
        }),

        // Reads past audits and totals from memory
        getAuditHistory: tool({
          description: "Get recent audits and the totals for each carrier.",
          inputSchema: z.object({}),
          execute: async () => ({
            totalsByCarrier: this.sql`
              SELECT carrier, COUNT(*) AS audits,
                SUM(overbilled) AS total_overbilled,
                SUM(underbilled) AS total_underbilled
              FROM audits
              WHERE status = 'complete'
              GROUP BY carrier`,
            recentAudits: this.sql`
              SELECT invoice_number, carrier, status, billed_total,
                expected_total, overbilled, underbilled, created_at
              FROM audits
              ORDER BY created_at DESC
              LIMIT 20`
          })
        }),

        // Adds or changes rates, but only after a person approves it
        saveContract: tool({
          description:
            "Add a carrier or replace its rates. Include every rate. The user must approve this.",
          inputSchema: z.object({
            carrier: z.string(),
            linehaul_per_mile: z.number(),
            fuel_surcharge_pct: z.number(),
            detention_per_hour: z.number(),
            detention_free_hours: z.number(),
            overweight_fee: z.number(),
            overweight_over_lbs: z.number()
          }),
          needsApproval: async () => true,
          execute: async (c) => {
            this.sql`INSERT OR REPLACE INTO contracts VALUES (
              ${c.carrier}, ${c.linehaul_per_mile}, ${c.fuel_surcharge_pct},
              ${c.detention_per_hour}, ${c.detention_free_hours},
              ${c.overweight_fee}, ${c.overweight_over_lbs}
            )`;
            return { saved: c };
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;