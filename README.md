# Invoice Audit Agent

An AI agent that checks freight carrier invoices against contract rates and flags billing errors.

**Live demo:** https://cf-ai-invoice-audit-agent.jmenlife.workers.dev

I worked in freight for years, and checking carrier invoices against contracts was part of the job. Fees like detention and overweight were easy to get wrong. I wanted to see if an AI agent could handle that first pass while a person stays in charge of the final call.

All sample data here is made up. Demo Carrier is not a real company.

## How it covers the assignment

| Requirement | What I used |
| --- | --- |
| LLM | Llama 3.3 on Workers AI reads the invoice. GLM 4.7 Flash on Workers AI runs the chat. |
| Workflow | Cloudflare Workflows runs each audit in steps and retries the AI step if it fails. |
| User input | A chat page where you paste an invoice or ask a question. |
| Memory | A Durable Object stores chat history, contract rates, and past audits in SQLite. |

## How an audit works

1. You paste an invoice into the chat.
2. Llama 3.3 turns the invoice text into structured data.
3. The app looks up that carrier's rates.
4. Plain code compares each charge to the contract.
5. The result is saved and posted in the chat.

## Try it

Paste this into the chat:

```text
INVOICE DC-1042
Carrier: Demo Carrier
Load 88213: Dallas, TX to Kansas City, MO
Miles: 550
Weight: 41,200 lbs
Detention: 5 hours at receiver

Linehaul 550 mi          $1,320.00
Fuel surcharge             $285.00
Detention 5 hrs            $375.00
Overweight fee             $150.00
TOTAL                    $2,130.00
```

It should come back overbilled by $347.40:

| Charge | Billed | Contract |
| --- | --- | --- |
| Fuel surcharge | $285.00 | $237.60 |
| Detention | $375.00 | $225.00 |
| Overweight fee | $150.00 | $0.00 |

Then try these:

- `How much has Demo Carrier overbilled us so far?`
- `Change Demo Carrier's detention rate to $85 per hour`

The rate change won't save until you approve it.

## Run it locally

You need Node.js 22 or newer and a free Cloudflare account with a workers.dev subdomain. You need to log in because Workers AI runs on Cloudflare, even during local development.

```bash
npm install
npx wrangler login
npm run dev
```

Then open http://localhost:5173.

To deploy your own copy:

```bash
npm run deploy
```

## Decisions I made

- **Code does the math.** The AI reads the invoice, but the dollar amounts come from `src/audit.ts`. In one test, the numbers were right, but the AI's written notes got two details wrong. So now the audit summary is written by code.
- **Two models.** I started with Llama 3.3 for the chat, but Workers AI returned an internal error when the template's tools were included. I didn't confirm the exact cause. I moved the chat to GLM 4.7 Flash and kept Llama 3.3 for reading invoices.
- **People approve rate changes.** The agent can't change a contract rate on its own.
- **Each browser gets its own agent.** Every visitor has a private chat and audit history.

## Limits

- It only takes pasted text, not PDFs.
- It checks linehaul, fuel, detention, and overweight charges. Any other charge is flagged because it has no contract rate.
- There is no login.
- The AI can misread an invoice, so a person should review every result.

## Project files

| File | What it does |
| --- | --- |
| `src/server.ts` | Chat agent, tools, and SQLite memory |
| `src/workflow.ts` | The audit Workflow |
| `src/audit.ts` | The audit rules and math |
| `src/app.tsx` | The chat page |

## How I built it

I started from Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter) template and used Claude to help build it. My prompts are in [PROMPTS.md](./PROMPTS.md).
