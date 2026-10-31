import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok } from "./helpers";

// Maintenance against a machine: the kitchen's microwave, oven, fridge, washing machine and water purifier.
// The owner lists them; the front desk books a task against one and keeps notes on it.
describe("Areas, equipment and task notes", () => {
  beforeAll(seed);

  it("the owner adds the kitchen and its equipment; the desks cannot", async () => {
    const area = await ok("shaji", "POST", "/api/admin/locations", { name: "Kitchen" });
    expect(area).toMatchObject({ name: "Kitchen", code: "KITCHEN" });
    expect((await api("shaji", "POST", "/api/admin/locations", { name: "kitchen" })).status).toBe(409);
    const eq = await ok("shaji", "POST", "/api/admin/equipment", { location_id: area.id, names: ["Microwave", "Oven", "Fridge", "Washing Machine", "Water Purifier", "Fridge"] });
    expect(eq.ids).toHaveLength(5); // the repeated Fridge is added once
    expect((await api("sindhu", "POST", "/api/admin/equipment", { location_id: area.id, name: "Kettle" })).status).toBe(403);
    const ref = await ok("sindhu", "GET", "/api/ref");
    expect(ref.locations.some((l: any) => l.name === "Kitchen" && l.kind === "area")).toBe(true);
    expect(ref.equipment.filter((e: any) => e.location_id === area.id).map((e: any) => e.name).sort()).toEqual(["Fridge", "Microwave", "Oven", "Washing Machine", "Water Purifier"]);
  });

  it("the front desk books maintenance on the fridge with a note, then adds notes as the job goes on", async () => {
    const ref = await ok("sindhu", "GET", "/api/ref");
    const kitchen = ref.locations.find((l: any) => l.name === "Kitchen");
    const fridge = ref.equipment.find((e: any) => e.name === "Fridge");
    const t = await ok("sindhu", "POST", "/api/tasks", { kind: "maintenance", location_id: kitchen.id, equipment_id: fridge.id, notes: "Not cooling since morning; milk moved to the guest fridge" });
    await ok("sindhu", "POST", `/api/tasks/${t.id}/notes`, { text: "Technician called, visiting tomorrow 11 am" });
    const list = await ok("sindhu", "GET", "/api/tasks");
    const task = list.tasks.find((x: any) => x.id === t.id);
    expect(task).toMatchObject({ kind: "maintenance", location_name: "Kitchen", equipment_name: "Fridge", title: "maintenance · Kitchen · Fridge" });
    const lines = task.notes.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Sindhu: Not cooling since morning/);
    expect(lines[1]).toMatch(/Sindhu: Technician called/);
    // Equipment must belong to the chosen area.
    const room = ref.locations.find((l: any) => l.kind === "room");
    expect((await api("sindhu", "POST", "/api/tasks", { kind: "repair", location_id: room.id, equipment_id: fridge.id })).status).toBe(400);
    // A retired machine is no longer offered.
    await ok("shaji", "PATCH", `/api/admin/equipment/${fridge.id}`, { active: false });
    expect((await ok("sindhu", "GET", "/api/ref")).equipment.some((e: any) => e.id === fridge.id)).toBe(false);
  });
});
