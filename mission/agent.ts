import type { WorkshopInputs } from './contracts.js';
import {
  agendaArtifactContentSchema,
  createEventArtifactContent,
  eventCopySchema,
  missionAgentInstructions,
  workshopIntakeProposalSchema,
  validateWorkshopIntake,
  validateWorkshopSources,
  validateAgendaSchedule,
  validateWorkshopPlan,
  type WorkshopSourceDocument,
  type WorkshopGenerator,
  type WorkshopPlanContent,
  type WorkshopPlanCheck,
} from './artifacts.js';
import { calculateBudgetCapacity, workshopInputsSchema, type PerPersonCost, type Venue } from './domain.js';

export interface WorkshopIntakeGenerator {
  generateIntake(input: {
    instructions: string;
    outputSchema: typeof workshopIntakeProposalSchema;
    sources: readonly WorkshopSourceDocument[];
  }): Promise<unknown>;
}

export async function runWorkshopIntakeAgent(
  rawSources: readonly unknown[],
  generator: WorkshopIntakeGenerator,
) {
  const sources = validateWorkshopSources(rawSources);
  const proposal = await generator.generateIntake({
    instructions: missionAgentInstructions.intake,
    outputSchema: workshopIntakeProposalSchema,
    sources,
  });
  return validateWorkshopIntake(proposal, sources);
}

export type WorkshopAgentResult =
  | { status: 'needs_input'; budget: ReturnType<typeof calculateBudgetCapacity> }
  | { status: 'ready'; output: WorkshopPlanContent; checks: WorkshopPlanCheck[] };

export async function runWorkshopAgent(
  rawInputs: WorkshopInputs,
  venues: readonly Venue[],
  costs: readonly PerPersonCost[],
  generator: WorkshopGenerator,
): Promise<WorkshopAgentResult> {
  const inputs = workshopInputsSchema.parse(rawInputs);
  const budget = calculateBudgetCapacity(inputs, venues, costs);
  if (!budget.selected || !budget.selected.capacityPass || !budget.selected.budgetPass || budget.decision) {
    return { status: 'needs_input', budget };
  }

  const agenda = agendaArtifactContentSchema.parse(await generator.generateAgenda({
    instructions: missionAgentInstructions.agenda,
    outputSchema: agendaArtifactContentSchema,
    inputs,
    selectedVenue: budget.selected,
    perPersonThb: budget.selected.perPersonThb,
  }));
  const agendaCheck = validateAgendaSchedule(agenda, inputs);
  if (!agendaCheck.passed) throw new Error(`Invalid agenda: ${agendaCheck.errors.join(' ')}`);

  const copy = eventCopySchema.parse(await generator.generateEventCopy({
    instructions: missionAgentInstructions.eventCopy,
    outputSchema: eventCopySchema,
    inputs,
    agenda,
  }));
  const output = { budget, agenda, event: createEventArtifactContent(copy, inputs, budget.selected) };
  const validation = validateWorkshopPlan(output, inputs, venues, costs);
  if (!validation.valid || !validation.output) {
    throw new Error(`Mission output validation failed: ${validation.checks.filter(check => !check.passed).map(check => check.summary).join(' ')}`);
  }
  return { status: 'ready', output: validation.output, checks: validation.checks };
}
