import test from "node:test";
import assert from "node:assert/strict";
import { auditInvoice, type Invoice } from "./audit.ts";

const contract = {
  carrier: "Demo Carrier",
  linehaul_per_mile: 2.40,
  fuel_surcharge_pct: 18,
  detention_per_hour: 75,
  detention_free_hours: 2,
  overweight_fee: 150,
  overweight_over_lbs: 44000,
};

function cleanInvoice(): Invoice {
  return {
    carrier: "Demo Carrier",
    invoiceNumber: "INV-1001",
    miles: 300,
    weightLbs: 38500,
    detentionHours: 1,
    statedTotal: 849.60,
    charges: [
      { type: "linehaul", description: "Linehaul", amount: 720 },
      { type: "fuel", description: "Fuel surcharge", amount: 129.60 },
    ],
  };
}

// Test 1: Clean invoice
test("clean invoice has no billing discrepancies", () => {
  const result = auditInvoice(contract, cleanInvoice());

  assert.equal(result.billedTotal, 849.60);
  assert.equal(result.expectedTotal, 849.60);
  assert.equal(result.overbilled, 0);
  assert.equal(result.underbilled, 0);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.warnings, []);
});

// Test 2: Overbilled invoice
test("identifies overbilled fuel, detention, and overweight charges", () => {
  const invoice: Invoice = {
    ...cleanInvoice(),
    miles: 550,
    weightLbs: 41200,
    detentionHours: 5,
    statedTotal: 2130,
    charges: [
      { type: "linehaul", description: "Linehaul", amount: 1320 },
      { type: "fuel", description: "Fuel surcharge", amount: 285 },
      { type: "detention", description: "Detention", amount: 375 },
      { type: "overweight", description: "Overweight fee", amount: 150 },
    ],
  };

  const result = auditInvoice(contract, invoice);

  assert.equal(result.billedTotal, 2130);
  assert.equal(result.expectedTotal, 1782.60);
  assert.equal(result.overbilled, 347.40);
  assert.equal(result.underbilled, 0);
  assert.equal(result.findings.length, 4);
  assert.deepEqual(result.warnings, []);
});

// Test 3: Missing detention fee
test("identifies a missing detention charge", () => {
  const invoice = {
    ...cleanInvoice(),
    detentionHours: 4,
  };

  const result = auditInvoice(contract, invoice);

  assert.equal(result.billedTotal, 849.60);
  assert.equal(result.expectedTotal, 999.60);
  assert.equal(result.overbilled, 0);
  assert.equal(result.underbilled, 150);
  assert.equal(result.findings.length, 3);
  assert.deepEqual(result.warnings, []);
});

// Test 4: Valid overweight fee
test("accepts an overweight fee when the shipment exceeds the threshold", () => {
    const invoice: Invoice = {
    ...cleanInvoice(),
    weightLbs: 45000,
    statedTotal: 999.60,
    charges: [
      ...cleanInvoice().charges,
      { type: "overweight", description: "Overweight fee", amount: 150 },
    ],
  };

  const result = auditInvoice(contract, invoice);

  assert.equal(result.billedTotal, 999.60);
  assert.equal(result.expectedTotal, 999.60);
  assert.equal(result.overbilled, 0);
  assert.equal(result.underbilled, 0);
  assert.equal(result.findings.length, 3);
  assert.deepEqual(result.warnings, []);
});

// Test 5: Other charge
test("flags an other charge as overbilled and keeps its description", () => {
    const invoice: Invoice = {
    ...cleanInvoice(),
    statedTotal: 889.60,
    charges: [
      ...cleanInvoice().charges,
      { type: "other", description: "Admin fee", amount: 40 },
    ],
  };

  const result = auditInvoice(contract, invoice);

  assert.equal(result.billedTotal, 889.60);
  assert.equal(result.expectedTotal, 849.60);
  assert.equal(result.overbilled, 40);
  assert.equal(result.underbilled, 0);
  assert.equal(result.findings.length, 3);

  const adminFinding = result.findings.find(
    (finding) => finding.item === "Admin fee"
  );

  assert.ok(adminFinding);
  assert.equal(adminFinding.billed, 40);
  assert.equal(adminFinding.expected, 0);
  assert.equal(adminFinding.variance, 40);
  assert.deepEqual(result.warnings, []);
});

// Test 6: No miles listed
test("uses billed linehaul when miles are zero and adds a warning", () => {
  const invoice = {
    ...cleanInvoice(),
    miles: 0,
  };

  const result = auditInvoice(contract, invoice);

  assert.equal(result.billedTotal, 849.60);
  assert.equal(result.expectedTotal, 849.60);
  assert.equal(result.overbilled, 0);
  assert.equal(result.underbilled, 0);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.warnings, [
    "No miles listed, so linehaul could not be checked.",
  ]);
});

// Test 7: Stated total does not match line items
test("warns when the stated total differs from the sum of line items", () => {
  const invoice = {
    ...cleanInvoice(),
    statedTotal: 900,
  };

  const result = auditInvoice(contract, invoice);

  assert.equal(result.billedTotal, 849.60);
  assert.equal(result.expectedTotal, 849.60);
  assert.equal(result.overbilled, 0);
  assert.equal(result.underbilled, 0);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.warnings, [
    "The stated total does not match the line items.",
  ]);
});