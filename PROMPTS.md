# Prompts

These are the prompts I used with AI while building the Carrier Invoice Checker, my Cloudflare assignment. They are listed in the order I sent them. ChatGPT's replies are not included.

## Prompt 1: Planning the app

I'm building an AI app on Cloudflare for a job assignment. It needs an LLM, a workflow, chat input, and memory.

My idea is a carrier invoice checker. In my freight work, carriers send invoices and often they dont match their receipts and POD.

A user pastes in an invoice and needs to get back if there's a discrepancy with bills

To keep it small, it will only take pasted text, use made up data with one carrier, and run on Cloudflare's free plan.

Don't write code yet. Give me the simplest plan, explain what each Cloudflare tool does in plain English, and list the biggest risks.

**Result:** ChatGPT proposed a small build using Workers, Workers AI, Workflows, D1, and a basic chat page. It explained each tool, listed the biggest risks, and used a made up residential surcharge example with a fictional carrier.

## Prompt 2: Correcting the plan and comparing memory options

Before we build, I want to correct a few things in your plan.

The real problem from my freight work was carrier invoices with missing or wrong fee amounts, especially detention and overweight. I checked hundreds of invoices a month. I caught these errors by comparing each invoice to the proof of delivery and the agreed contract, then sent the carrier a correction request with the documents. Use this instead of the residential surcharge example.

The AI should only read the invoice. Plain code should compare the charges, so every dollar can be traced and tested.

Here are the audit rules, using made up rates:

* Linehaul: miles times the contract rate per mile.
* Fuel: a contract percent of the expected linehaul, not the billed linehaul.
* Detention: an hourly rate, only after the contract's free hours.
* Overweight: a flat fee, only when the load is above the contract's weight threshold.

Flag any wrong charge, any charge that isn't in the contract, and any contract fee that was left off. Send an invoice to a person for review if a key detail is missing or the stated total doesn't match the line items. The app should never send anything to a carrier on its own.

You chose D1 for memory. Compare it with Durable Objects for this app, recommend one, and explain why.

Still no code. Update the plan, then tell me what you need from me before we write the first test.

**Result:** ChatGPT rebuilt the plan around my detention and overweight audit process, with the AI reading the invoice and plain code checking the charges. It recommended D1 over Durable Objects, proposed test contract rates, and listed the decisions it needed before the first test.

## Prompt 3: Setting the first test

Here are my decisions for the first test.

Input: The user pastes the invoice and POD details. The contract stays in the app's memory, because an auditor already has the contract on file and each load brings a new invoice and POD.

Contract: Use your proposed test values.

Detention: Use the arrival and departure times on the POD. Count full hours after the free time, rounded down.

Rounding: Round each expected charge to cents.

Two changes to your plan:

1. Use the SQLite database inside a Durable Object instead of D1. Cloudflare's agents starter already runs each chat agent in a Durable Object, so D1 would add a second place to store data. Tell me if there's a strong reason to keep D1.
2. Cut contract versions and the review queue table for now. Start with one contract and store a status on each audit.

First test:

Invoice: 500 miles. Billed linehaul $1,350.00, fuel $187.50, detention $75.00, no overweight fee. Total $1,612.50.

POD: Arrived 8:00 AM, departed 12:00 PM, weight 47,000 lbs.

Results I expect:

* Linehaul: expected $1,250.00, overbilled by $100.00
* Fuel: expected $187.50, correct
* Detention: expected $150.00, underbilled by $75.00
* Overweight: expected $200.00, missing charge
* Expected total: $1,787.50
* Total overbilled: $100.00
* Total underbilled: $275.00

Second test: Use the same invoice with no miles. It should go to human review instead of guessing.

Write only the audit rules and these two tests. No AI, chat, or Cloudflare code yet.

**Result:** ChatGPT agreed to use SQLite inside a Durable Object, saying there was no strong reason to keep D1, and removed contract versions and the review queue. It wrote audit spec v1 with the rules and both tests.

## Prompt 4: Replacing the spec

I've changed my mind. replace the spec with this.

Contract: Demo Carrier. Linehaul is $2.40 per mile. Fuel is 18% of expected linehaul. Detention is $75 per hour after 2 free hours. The overweight fee is $150 above 44,000 lbs.

Input: The user pastes the invoice only, with no POD section. The invoice lists miles, weight, detention hours, charges, and a stated total.

Output: Return invoiceNumber, carrier, billedTotal, expectedTotal, overbilled, underbilled, findings, and warnings. There is no HUMAN_REVIEW status.

* If miles are 0, use billed linehaul as the expected linehaul and add a warning.
* If the stated total doesn't match the line items, add a warning.
* Charges of type "other" have an expected amount of $0.

Names: Use auditInvoice(contract, invoice). Contract fields are carrier, linehaul_per_mile, fuel_surcharge_pct, detention_per_hour, detention_free_hours, overweight_fee, and overweight_over_lbs. Invoice fields are carrier, invoiceNumber, miles, weightLbs, detentionHours, statedTotal, and charges.

My linehaul rule:

```ts
// Rule 1: linehaul is miles times the contract rate.
let expectedLinehaul = round(invoice.miles * contract.linehaul_per_mile);
if (invoice.miles === 0) {
  expectedLinehaul = billed("linehaul");
  warnings.push("No miles listed, so linehaul could not be checked.");
}
```

Tests:

1. Clean: 300 miles, 38,500 lbs, 1 detention hour. Linehaul $720.00, fuel $129.60, stated total $849.60. Billed and expected totals are $849.60, with no errors.
2. Overbilled: 550 miles, 41,200 lbs, 5 detention hours. Linehaul $1,320.00, fuel $285.00, detention $375.00, overweight $150.00, stated total $2,130.00. Expected total is $1,782.60, and overbilled is $347.40.
3. Missing fee: Test 1 with 4 detention hours and no detention charge. Underbilled is $150.00.
4. Valid overweight: Test 1 at 45,000 lbs with a $150.00 overweight charge. Overbilled is $0.00.
5. Other charge: Test 1 plus a $40.00 admin fee. Overbilled is $40.00.
6. No miles: Test 1 with 0 miles. Overbilled is $0.00, with one warning.
7. Bad total: Test 1 with a stated total of $900.00. There is one warning.

My setup: I'm on a Mac with Node.js, Git, VS Code, and a Cloudflare account. I'm writing the code myself.

**Result:** ChatGPT replaced the spec with v2, covering the Demo Carrier contract, invoice only input, the output fields, and all seven tests. I corrected several parts of it in Prompt 5.

## Prompt 5: Correcting the spec

You didn't answer what I asked. Tell me what round, billed, and warnings each need to do. Don't write them for me.

Make these corrections:

1. Each charge has a type, description, and amount. For "other" charges, use the description as the finding's item name.
2. Each finding has item, billed, expected, and variance. Variance is billed minus expected. Remove chargeType, billedAmount, expectedAmount, difference, and status.
3. Keep every charge line in findings unless both billed and expected are $0. Update the finding counts: Test 1 has 2, Test 2 has 4, Test 3 has 3, Test 4 has 3, Test 5 has 3, Test 6 has 2, and Test 7 has 2.
4. Use these exact warnings:
   * No miles listed, so linehaul could not be checked.
   * The stated total does not match the line items.
5. Keep my round helper at two decimal places. Don't use integer cents.

Using node:test is fine. The test file should import from ./audit.ts.

Don't write the code. Update the spec

**Result:** ChatGPT explained what round, billed, and warnings each need to do without writing them, then applied my corrections in spec v3. It set fuel_surcharge_pct to 0.18 and described billed as finding one matching charge, which I corrected in Prompt 6.

## Prompt 6: Finalizing the spec

Three corrections to v3:

1. Use fuel_surcharge_pct as 18, not 0.18. Expected fuel is expected linehaul times fuel_surcharge_pct divided by 100.
2. billed(type) should add up every charge of that type and return 0 if there are none. Each "other" charge still gets its own finding.
3. The files go in src/audit.ts and src/audit.test.ts inside a project called cf-ai-freight-audit-agent. I'm creating that project myself from cloudflare/agents-starter. I'm on Node 26, so node:test can run these TypeScript files directly.

Don't write the code. Confirm these changes in two or three lines

**Result:** ChatGPT confirmed all three changes: fuel_surcharge_pct is 18, billed adds up every matching charge, and the files go in src/audit.ts and src/audit.test.ts.

## Prompt 7: Writing the tests

The project is set up,Write the seven tests for src/audit.test.ts using node:test. Tell me, in plain English, the order to write its pieces.

**Result:** ChatGPT gave the order to write the file (imports, contract fixture, invoice helper, then the seven tests) and also wrote the complete src/audit.test.ts.

## Prompt 8: Planning the audit file

The test file is in, and it fails because src/audit.ts is empty. Now tell me, in plain English, the order to write the pieces of src/audit.ts, from top to bottom. Don't write the code.

**Result:** ChatGPT listed nine steps in plain English, moving from the output structure and helpers through the expected charges, findings, totals, and stated total check. It did not write any code.

## Prompt 9: Reviewing my first code

I wrote the first pieces of src/audit.ts: the output structure, round, the start of auditInvoice, billed, and my linehaul rule.

```ts
// The audit rules. There is no AI in this file on purpose:
// the AI reads the invoice, but plain code does the math.

export const CHARGE_TYPES = [
  "linehaul",
  "fuel",
  "detention",
  "overweight",
  "other"
] as const;

// These names match the columns in the contracts table.
export type ContractRates = {
  carrier: string;
  linehaul_per_mile: number;
  fuel_surcharge_pct: number;
  detention_per_hour: number;
  detention_free_hours: number;
  overweight_fee: number;
  overweight_over_lbs: number;
};

export type Invoice = {
  carrier: string;
  invoiceNumber: string;
  miles: number;
  weightLbs: number;
  detentionHours: number;
  statedTotal: number;
  charges: {
    type: (typeof CHARGE_TYPES)[number];
    description: string;
    amount: number;
  }[];
};

const round = (value: number) => Math.round(value * 100) / 100;

const sum = (values: number[]) =>
  round(values.reduce((total, value) => total + value, 0));

export function auditInvoice(contract: ContractRates, invoice: Invoice) {
  const billed = (type: string) =>
    sum(invoice.charges.filter((c) => c.type === type).map((c) => c.amount));

  const warnings: string[] = [];

  // Rule 1: linehaul is miles times the contract rate.
  let expectedLinehaul = round(invoice.miles * contract.linehaul_per_mile);
  if (invoice.miles === 0) {
    expectedLinehaul = billed("linehaul");
    warnings.push("No miles listed, so linehaul could not be checked.");
  }
```

Review this against the spec. Tell me what's wrong and why, but don't rewrite it. I'll make the fixes myself.

**Result:** ChatGPT said the structure, types, and linehaul rule were correct. It suggested two changes: be more deliberate about rounding in sum, and limit billed to the supported charge types instead of any string.

## Prompt 10: Reviewing the full audit file

I reviewed your two suggestions and I'm keeping my code. Invoice amounts are already in cents, so rounding the sum doesn't change the money. It only removes tiny decimal errors, which keeps my stated total check reliable. billed uses string to match the app I already built, and I only call it with four fixed charge names.

Here's the full src/audit.ts:

```ts
// The audit rules. There is no AI in this file on purpose:
// the AI reads the invoice, but plain code does the math.

export const CHARGE_TYPES = [
  "linehaul",
  "fuel",
  "detention",
  "overweight",
  "other"
] as const;

// These names match the columns in the contracts table.
export type ContractRates = {
  carrier: string;
  linehaul_per_mile: number;
  fuel_surcharge_pct: number;
  detention_per_hour: number;
  detention_free_hours: number;
  overweight_fee: number;
  overweight_over_lbs: number;
};

export type Invoice = {
  carrier: string;
  invoiceNumber: string;
  miles: number;
  weightLbs: number;
  detentionHours: number;
  statedTotal: number;
  charges: {
    type: (typeof CHARGE_TYPES)[number];
    description: string;
    amount: number;
  }[];
};

const round = (value: number) => Math.round(value * 100) / 100;

const sum = (values: number[]) =>
  round(values.reduce((total, value) => total + value, 0));

export function auditInvoice(contract: ContractRates, invoice: Invoice) {
  const billed = (type: string) =>
    sum(invoice.charges.filter((c) => c.type === type).map((c) => c.amount));

  const warnings: string[] = [];

  // Rule 1: linehaul is miles times the contract rate.
  let expectedLinehaul = round(invoice.miles * contract.linehaul_per_mile);
  if (invoice.miles === 0) {
    expectedLinehaul = billed("linehaul");
    warnings.push("No miles listed, so linehaul could not be checked.");
  }

  // Rule 2: fuel is a percent of what the linehaul should have been.
  const expectedFuel = round(
    expectedLinehaul * (contract.fuel_surcharge_pct / 100)
  );

  // Rule 3: detention only counts after the free hours.
  const billableHours = Math.max(
    0,
    invoice.detentionHours - contract.detention_free_hours
  );
  const expectedDetention = round(billableHours * contract.detention_per_hour);

  // Rule 4: the overweight fee only applies above the weight threshold.
  const expectedOverweight =
    invoice.weightLbs > contract.overweight_over_lbs
      ? contract.overweight_fee
      : 0;

  const lines = [
    { item: "Linehaul", billed: billed("linehaul"), expected: expectedLinehaul },
    { item: "Fuel surcharge", billed: billed("fuel"), expected: expectedFuel },
    { item: "Detention", billed: billed("detention"), expected: expectedDetention },
    { item: "Overweight fee", billed: billed("overweight"), expected: expectedOverweight },
    // Rule 5: anything else has no rate in the contract, so nothing is owed.
    ...invoice.charges
      .filter((c) => c.type === "other")
      .map((c) => ({ item: c.description, billed: c.amount, expected: 0 }))
  ];

  const findings = lines
    .filter((line) => line.billed !== 0 || line.expected !== 0)
    .map((line) => ({ ...line, variance: round(line.billed - line.expected) }));

  // Rule 6: the line items should add up to the total printed on the invoice.
  const billedTotal = sum(invoice.charges.map((c) => c.amount));
  if (invoice.statedTotal > 0 && invoice.statedTotal !== billedTotal) {
    warnings.push("The stated total does not match the line items.");
  }

  return {
    invoiceNumber: invoice.invoiceNumber,
    carrier: invoice.carrier,
    billedTotal,
    expectedTotal: sum(findings.map((f) => f.expected)),
    overbilled: sum(findings.filter((f) => f.variance > 0).map((f) => f.variance)),
    underbilled: sum(findings.filter((f) => f.variance < 0).map((f) => -f.variance)),
    findings,
    warnings
  };
}
```

Here are my test results:

```text
✔ clean invoice has no billing discrepancies (0.770625ms)

✔ identifies overbilled fuel, detention, and overweight charges (0.109584ms)

✔ identifies a missing detention charge (0.0855ms)

✔ accepts an overweight fee when the shipment exceeds the threshold (0.07675ms)

✔ flags an other charge as overbilled and keeps its description (0.123875ms)

✔ uses billed linehaul when miles are zero and adds a warning (0.103791ms)

ℹ tests 7

ℹ suites 0

ℹ pass 7

ℹ fail 0

ℹ cancelled 0

ℹ skipped 0

ℹ todo 0

ℹ duration_ms 73.85725
```

Review it against the spec. Tell me what's wrong and why, but don't rewrite it. I'll make any fixes myself

**Result:** ChatGPT accepted my reasons for keeping sum and billed as written. It found two spec discrepancies to fix: the extra `> 0` condition on the stated total warning, and the overweight fee not being rounded.




