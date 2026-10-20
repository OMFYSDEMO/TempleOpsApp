/**
 * Expense categories: one list for the API, the screens and the reports. `petty` marks what the property
 * manager can pay from the float; `bank` what the owner pays by transfer. A category can be both.
 * Codes are stored on expenses, so add new ones freely but never rename an existing code.
 */
export const EXPENSE_CATEGORIES = [
  { code: "repairs", label: "Repairs & maintenance", petty: true, bank: true },
  { code: "fnb", label: "Food & beverage", petty: true, bank: true },
  { code: "housekeeping", label: "Housekeeping & cleaning", petty: true, bank: true },
  { code: "amenities", label: "Guest amenities", petty: true, bank: true },
  { code: "laundry", label: "Laundry", petty: true, bank: true },
  { code: "transport", label: "Transport & fuel", petty: true, bank: true },
  { code: "utilities", label: "Power, water & gas", petty: true, bank: true },
  { code: "internet", label: "Internet & phone", petty: true, bank: true },
  { code: "subscriptions", label: "Subscriptions & software", petty: false, bank: true },
  { code: "rent", label: "Rent & lease", petty: false, bank: true },
  { code: "government_fees", label: "Government fees & licences", petty: true, bank: true },
  { code: "taxes", label: "Taxes & statutory payments", petty: false, bank: true },
  { code: "insurance", label: "Insurance", petty: false, bank: true },
  { code: "professional", label: "Professional fees", petty: true, bank: true },
  { code: "marketing", label: "Marketing & advertising", petty: true, bank: true },
  { code: "commission", label: "Agent commission", petty: false, bank: true },
  { code: "salaries", label: "Salaries & wages", petty: false, bank: true },
  { code: "staff_welfare", label: "Staff welfare", petty: true, bank: true },
  { code: "office", label: "Office & stationery", petty: true, bank: true },
  { code: "capital", label: "Furniture & equipment", petty: false, bank: true },
  { code: "bank_charges", label: "Bank & gateway charges", petty: false, bank: true },
  { code: "misc", label: "Miscellaneous", petty: true, bank: true },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["code"];
export const CATEGORIES = EXPENSE_CATEGORIES.map((c) => c.code) as unknown as readonly ExpenseCategory[];
export const categoryLabel = (code: string) => EXPENSE_CATEGORIES.find((c) => c.code === code)?.label ?? code;
