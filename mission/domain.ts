import { z } from 'zod';
import type { TaskKey, WorkshopInputs } from './contracts.js';

export const MAX_ATTENDEES = 200;
export const MAX_MONEY_THB = 100_000_000;
export const MAX_SOURCE_FILE_BYTES = 200_000;

const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const workshopInputsSchema = z.object({
  topic: z.string().trim().min(1).max(160),
  audience: z.string().trim().min(1).max(240),
  date: z.string().refine(validDate, 'Use a real calendar date in YYYY-MM-DD format.'),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm time.'),
  endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm time.'),
  attendees: z.number().int().min(1).max(MAX_ATTENDEES),
  maxBudgetThb: z.number().int().min(0).max(MAX_MONEY_THB),
  venueId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
}).strict().superRefine((input, context) => {
  if (input.endTime <= input.startTime) {
    context.addIssue({ code: 'custom', path: ['endTime'], message: 'End time must be after start time on the same day.' });
  }
});

export interface Venue {
  id: string;
  name: string;
  capacity: number;
  fixedCostThb: number;
  sourceLine: number;
}

export interface PerPersonCost {
  item: string;
  unitCostThb: number;
  sourceLine: number;
}

const venueSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
  name: z.string().trim().min(1).max(120),
  capacity: z.number().int().min(1).max(1_000_000),
  fixedCostThb: z.number().int().min(0).max(MAX_MONEY_THB),
  sourceLine: z.number().int().min(1),
}).strict();

const perPersonCostSchema = z.object({
  item: z.string().trim().min(1).max(120),
  unitCostThb: z.number().int().min(0).max(MAX_MONEY_THB),
  sourceLine: z.number().int().min(1),
}).strict();

const parseCsv = (text: string, label: string): { values: string[]; line: number }[] => {
  if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_SOURCE_FILE_BYTES} bytes.`);
  }

  const rows: { values: string[]; line: number }[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  let started = false;
  let line = 1;
  let recordLine = 1;

  const finishCell = () => { row.push(cell); cell = ''; afterQuote = false; };
  const finishRow = () => {
    finishCell();
    if (row.some(value => value.trim() !== '')) rows.push({ values: row, line: recordLine });
    row = [];
    started = false;
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else {
        cell += character;
        if (character === '\n' || character === '\r') {
          line++;
          if (character === '\r' && text[index + 1] === '\n') { cell += '\n'; index++; }
        }
      }
      continue;
    }

    if (character === ',') {
      finishCell(); started = true; continue;
    }
    if (character === '\n' || character === '\r') {
      finishRow();
      if (character === '\r' && text[index + 1] === '\n') index++;
      line++;
      recordLine = line;
      continue;
    }
    if (afterQuote) {
      if (character === ' ' || character === '\t') continue;
      throw new Error(`${label} has unexpected text after a quoted CSV field.`);
    }
    if (character === '"') {
      if (cell.length !== 0) throw new Error(`${label} has a quote inside an unquoted CSV field.`);
      quoted = true; started = true; continue;
    }
    cell += character; started = true;
  }

  if (quoted) throw new Error(`${label} ends inside a quoted CSV field.`);
  if (started || row.length > 0 || cell.length > 0 || afterQuote) finishRow();
  return rows;
};

const integerField = (value: string, label: string, row: number, min: number, max: number) => {
  if (!/^\d+$/.test(value)) throw new Error(`${label} row ${row} must be a whole number.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} row ${row} must be between ${min} and ${max}.`);
  }
  return number;
};

const recordsFromCsv = (text: string, label: string, expectedHeaders: readonly string[]) => {
  const [{ values: headerRow }, ...dataRows] = parseCsv(text, label);
  if (!headerRow) throw new Error(`${label} is empty.`);
  const headers = headerRow.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '').trim() : value.trim());
  if (new Set(headers).size !== headers.length || expectedHeaders.some(header => !headers.includes(header))
      || headers.some(header => !expectedHeaders.includes(header))) {
    throw new Error(`${label} must contain exactly these headers: ${expectedHeaders.join(', ')}.`);
  }
  return dataRows.map(({ values, line }) => {
    if (values.length !== headers.length) throw new Error(`${label} row ${line} has ${values.length} fields; expected ${headers.length}.`);
    return { record: Object.fromEntries(headers.map((header, column) => [header, values[column]!.trim()])), sourceLine: line };
  });
};

export function parseVenuesCsv(text: string): Venue[] {
  const records = recordsFromCsv(text, 'venues.csv', ['venue_id', 'name', 'capacity', 'fixed_cost_thb']);
  const ids = new Set<string>();
  return records.map(({ record, sourceLine }) => {
    const id = record.venue_id!;
    const name = record.name!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id)) throw new Error(`venues.csv row ${sourceLine} has an invalid venue_id.`);
    if (!name || name.length > 120) throw new Error(`venues.csv row ${sourceLine} needs a name of 1–120 characters.`);
    if (ids.has(id)) throw new Error(`venues.csv row ${sourceLine} repeats venue_id ${id}.`);
    ids.add(id);
    return { id, name, capacity: integerField(record.capacity!, 'venues.csv capacity', sourceLine, 1, 1_000_000),
      fixedCostThb: integerField(record.fixed_cost_thb!, 'venues.csv fixed_cost_thb', sourceLine, 0, MAX_MONEY_THB), sourceLine };
  });
}

export function parsePerPersonCostsCsv(text: string): PerPersonCost[] {
  const records = recordsFromCsv(text, 'costs.csv', ['item', 'unit', 'unit_cost_thb']);
  const items = new Set<string>();
  let total = 0;
  const costs = records.map(({ record, sourceLine }) => {
    const item = record.item!;
    if (!item || item.length > 120) throw new Error(`costs.csv row ${sourceLine} needs an item name of 1–120 characters.`);
    if (record.unit !== 'person') throw new Error(`costs.csv row ${sourceLine} must use unit=person.`);
    if (items.has(item)) throw new Error(`costs.csv row ${sourceLine} repeats item ${item}.`);
    items.add(item);
    const unitCostThb = integerField(record.unit_cost_thb!, 'costs.csv unit_cost_thb', sourceLine, 0, MAX_MONEY_THB);
    total += unitCostThb;
    if (!Number.isSafeInteger(total) || total > MAX_MONEY_THB) throw new Error('Total per-person cost exceeds the money limit.');
    return { item, unitCostThb, sourceLine };
  });
  if (costs.length === 0) throw new Error('costs.csv needs at least one per-person cost.');
  return costs;
}

export interface VenueAssessment extends Venue {
  perPersonThb: number;
  totalThb: number;
  remainingBudgetThb: number;
  capacityPass: boolean;
  budgetPass: boolean;
}

export type BudgetDecision =
  | { code: 'CHOOSE_VENUE'; message: string; options: VenueAssessment[] }
  | { code: 'ADD_OR_CHANGE_SOURCE'; message: string; options: [] };

export interface BudgetCapacityResult {
  selected: VenueAssessment | null;
  options: VenueAssessment[];
  feasibleOptions: VenueAssessment[];
  checks: { code: 'VENUE_EXISTS' | 'CAPACITY' | 'BUDGET'; passed: boolean; summary: string; sourceLines: number[] }[];
  decision: BudgetDecision | null;
}

export function calculateBudgetCapacity(
  rawInputs: WorkshopInputs,
  venues: readonly Venue[],
  costs: readonly PerPersonCost[],
): BudgetCapacityResult {
  const inputs = workshopInputsSchema.parse(rawInputs);
  const parsedVenues = z.array(venueSchema).parse(venues);
  const parsedCosts = z.array(perPersonCostSchema).min(1).parse(costs);
  const perPersonThb = parsedCosts.reduce((sum, cost) => sum + cost.unitCostThb, 0);
  if (!Number.isSafeInteger(perPersonThb) || perPersonThb > MAX_MONEY_THB) throw new Error('Total per-person cost exceeds the money limit.');

  const options = parsedVenues.map(venue => {
    const totalThb = venue.fixedCostThb + inputs.attendees * perPersonThb;
    if (!Number.isSafeInteger(totalThb)) throw new Error(`Cost for venue ${venue.id} exceeds the safe integer limit.`);
    return { ...venue, perPersonThb, totalThb, remainingBudgetThb: inputs.maxBudgetThb - totalThb,
      capacityPass: inputs.attendees <= venue.capacity, budgetPass: totalThb <= inputs.maxBudgetThb };
  });
  const selected = options.find(option => option.id === inputs.venueId) ?? null;
  const feasibleOptions = options.filter(option => option.capacityPass && option.budgetPass);
  const checks: BudgetCapacityResult['checks'] = [
    { code: 'VENUE_EXISTS', passed: selected !== null,
      summary: selected ? `Selected venue: ${selected.name}.` : `Venue ${inputs.venueId} is not listed in venues.csv.`,
      sourceLines: selected ? [selected.sourceLine] : [] },
    { code: 'CAPACITY', passed: selected?.capacityPass ?? false,
      summary: selected ? `${inputs.attendees} attendees / capacity ${selected.capacity}.` : 'Choose a venue from the source file first.',
      sourceLines: selected ? [selected.sourceLine] : [] },
    { code: 'BUDGET', passed: selected?.budgetPass ?? false,
      summary: selected ? `${selected.totalThb} / ${inputs.maxBudgetThb} THB.` : 'Choose a venue from the source file first.',
      sourceLines: selected ? [selected.sourceLine, ...parsedCosts.map(cost => cost.sourceLine)] : [] },
  ];

  let decision: BudgetDecision | null = null;
  if (!selected || !selected.capacityPass || !selected.budgetPass) {
    decision = feasibleOptions.length
      ? { code: 'CHOOSE_VENUE', message: `Choose a venue listed in venues.csv that fits ${inputs.attendees} attendees and ${inputs.maxBudgetThb} THB.`, options: feasibleOptions }
      : { code: 'ADD_OR_CHANGE_SOURCE', message: 'No listed venue fits these constraints. Add a source venue or reduce attendees/budget requirements.', options: [] };
  }
  return { selected, options, feasibleOptions, checks, decision };
}

export const missionTaskOrder: readonly TaskKey[] = [
  'intake', 'budget_capacity', 'agenda', 'event_content', 'validate_bundle',
];

export const missionTaskDependencies: Readonly<Record<TaskKey, readonly TaskKey[]>> = {
  intake: [],
  budget_capacity: ['intake'],
  agenda: ['intake'],
  event_content: ['budget_capacity', 'agenda'],
  validate_bundle: ['budget_capacity', 'agenda', 'event_content'],
};

export type WorkshopField = keyof WorkshopInputs;
export type WorkshopSourceFile = 'brief' | 'venues' | 'costs';

const fieldConsumers: Readonly<Record<WorkshopField, readonly TaskKey[]>> = {
  topic: ['agenda'], audience: ['agenda'], date: ['agenda'], startTime: ['agenda'], endTime: ['agenda'],
  attendees: ['budget_capacity'], maxBudgetThb: ['budget_capacity'], venueId: ['budget_capacity'],
};
const fileConsumers: Readonly<Record<WorkshopSourceFile, readonly TaskKey[]>> = {
  brief: ['intake'], venues: ['budget_capacity'], costs: ['budget_capacity'],
};

export function planMissionInvalidation(changes: {
  fields?: readonly WorkshopField[];
  files?: readonly WorkshopSourceFile[];
}): { rerun: TaskKey[]; reuse: TaskKey[]; reasons: Partial<Record<TaskKey, string[]>> } {
  const reasons: Partial<Record<TaskKey, string[]>> = {};
  const add = (task: TaskKey, reason: string) => { (reasons[task] ??= []).push(reason); };
  for (const field of changes.fields ?? []) for (const task of fieldConsumers[field]) add(task, `field:${field}`);
  for (const file of changes.files ?? []) for (const task of fileConsumers[file]) add(task, `file:${file}`);

  // The task order is topological, so every downstream task sees its changed inputs here.
  for (const task of missionTaskOrder) {
    if (reasons[task]) continue;
    const changedDependencies = missionTaskDependencies[task].filter(dependency => reasons[dependency]);
    for (const dependency of changedDependencies) add(task, `dependency:${dependency}`);
  }

  const rerun = missionTaskOrder.filter(task => reasons[task]);
  const reuse = missionTaskOrder.filter(task => !reasons[task]);
  return { rerun, reuse, reasons };
}
