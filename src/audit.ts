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
            ? round(contract.overweight_fee)
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