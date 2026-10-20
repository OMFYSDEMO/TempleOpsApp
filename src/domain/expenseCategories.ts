/**
 * Expense categories: one list for the API, the screens and the reports. `petty` marks what the property
 * manager can pay from the float; `bank` what the owner pays by transfer. A category can be both.
 * `family` groups the picker: Guests (what guests consume), Property (the building and its services), People, Business.
 * Codes are stored on expenses, so add new ones freely but never rename an existing code.
 */
export const EXPENSE_CATEGORIES = [
  { code: "repairs", label: "Repairs & maintenance", family: "Property", petty: true, bank: true },
  { code: "fnb", label: "Food & beverage", family: "Guests", petty: true, bank: true },
  { code: "housekeeping", label: "Housekeeping & cleaning", family: "Guests", petty: true, bank: true },
  { code: "amenities", label: "Guest amenities", family: "Guests", petty: true, bank: true },
  { code: "laundry", label: "Laundry", family: "Guests", petty: true, bank: true },
  { code: "transport", label: "Transport & fuel", family: "Guests", petty: true, bank: true },
  { code: "utilities", label: "Power, water & gas", family: "Property", petty: true, bank: true },
  { code: "internet", label: "Internet & phone", family: "Property", petty: true, bank: true },
  { code: "subscriptions", label: "Subscriptions & software", family: "Business", petty: false, bank: true },
  { code: "rent", label: "Rent & lease", family: "Property", petty: false, bank: true },
  { code: "government_fees", label: "Government fees & licences", family: "Business", petty: true, bank: true },
  { code: "taxes", label: "Taxes & statutory payments", family: "Business", petty: false, bank: true },
  { code: "insurance", label: "Insurance", family: "Property", petty: false, bank: true },
  { code: "professional", label: "Professional fees", family: "People", petty: true, bank: true },
  { code: "marketing", label: "Marketing & advertising", family: "Business", petty: true, bank: true },
  { code: "commission", label: "Agent commission", family: "People", petty: false, bank: true },
  { code: "salaries", label: "Salaries & wages", family: "People", petty: false, bank: true },
  { code: "staff_welfare", label: "Staff welfare", family: "People", petty: true, bank: true },
  { code: "office", label: "Office & stationery", family: "Business", petty: true, bank: true },
  { code: "capital", label: "Furniture & equipment", family: "Property", petty: false, bank: true },
  { code: "bank_charges", label: "Bank & gateway charges", family: "Business", petty: false, bank: true },
  { code: "misc", label: "Miscellaneous", family: "Business", petty: true, bank: true },
] as const;

export const EXPENSE_FAMILIES = ["Guests", "Property", "People", "Business"] as const;
/** The handful offered as one-tap chips; everything else sits in the grouped dropdown. */
export const COMMON_PETTY = ["fnb", "housekeeping", "repairs", "transport", "laundry", "amenities"];
export const COMMON_BANK = ["utilities", "salaries", "professional", "subscriptions", "rent", "repairs"];

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["code"];
export const CATEGORIES = EXPENSE_CATEGORIES.map((c) => c.code) as unknown as readonly ExpenseCategory[];
export const categoryLabel = (code: string) => EXPENSE_CATEGORIES.find((c) => c.code === code)?.label ?? code;
