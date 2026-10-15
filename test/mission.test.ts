import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runWorkshopAgent, runWorkshopIntakeAgent } from '../mission/agent.js';
import {
  validateWorkshopIntake,
  validateWorkshopPlan,
  type WorkshopGenerator,
} from '../mission/artifacts.js';
import { parsePerPersonCostsCsv, parseVenuesCsv, planMissionInvalidation } from '../mission/domain.js';
import type { WorkshopInputs } from '../mission/contracts.js';

const inputs = (attendees = 60, venueId = 'A'): WorkshopInputs => ({
  topic: 'AI for Community', audience: 'ผู้ดูแลชมรมและ community', date: '2026-10-24',
  startTime: '13:00', endTime: '16:00', attendees, maxBudgetThb: 15_000, venueId,
});

async function sources() {
  const [venuesCsv, costsCsv] = await Promise.all([
    readFile('fixtures/workshop/venues.csv', 'utf8'),
    readFile('fixtures/workshop/costs.csv', 'utf8'),
  ]);
  return { venues: parseVenuesCsv(venuesCsv), costs: parsePerPersonCostsCsv(costsCsv) };
}

function generator(calls: string[] = [], agenda = {
  title: 'AI for Community', objectives: ['ใช้ AI วางแผนกิจกรรมชุมชน'],
  sessions: [
    { startTime: '13:00', endTime: '14:20', title: 'เริ่มต้นใช้ AI', activity: 'ทดลองเขียนคำสั่งสำหรับงานชุมชน' },
    { startTime: '14:30', endTime: '16:00', title: 'ลงมือวางแผน', activity: 'สร้างแผนกิจกรรมกลุ่ม' },
  ],
}): WorkshopGenerator {
  return {
    async generateAgenda() { calls.push('agenda'); return agenda; },
    async generateEventCopy() { calls.push('event'); return { title: 'AI for Community', description: 'เวิร์กช็อปลงมือใช้ AI เพื่อวางแผนกิจกรรมชุมชน' }; },
  };
}

test('Mission Agent generates a plan from confirmed inputs and validates facts', async () => {
  const { venues, costs } = await sources();
  const result = await runWorkshopAgent(inputs(), venues, costs, generator());
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.output.budget.selected?.totalThb, 10_800);
  assert.equal(result.output.event.venueName, 'ห้อง A');
  assert.equal(result.output.event.date, inputs().date);
  assert(result.checks.every(check => check.passed));
});

test('different workshop topics reach the generator instead of returning a canned plan', async () => {
  const { venues, costs } = await sources();
  const topics: string[] = [];
  const dynamicGenerator: WorkshopGenerator = {
    async generateAgenda({ inputs: current }) {
      topics.push(current.topic);
      return {
        title: current.topic, objectives: [`ฝึกเรื่อง ${current.topic}`],
        sessions: [{ startTime: current.startTime, endTime: current.endTime, title: current.topic, activity: `ลงมือทำเรื่อง ${current.topic}` }],
      };
    },
    async generateEventCopy({ inputs: current }) {
      return { title: current.topic, description: `กิจกรรมสำหรับ ${current.audience} ในหัวข้อ ${current.topic}` };
    },
  };

  for (const topic of ['AI for Community', 'วางแผนการเงินชุมชน']) {
    const result = await runWorkshopAgent({ ...inputs(), topic }, venues, costs, dynamicGenerator);
    assert.equal(result.status, 'ready');
    if (result.status === 'ready') assert.equal(result.output.event.title, topic);
  }
  assert.deepEqual(topics, ['AI for Community', 'วางแผนการเงินชุมชน']);
});

test('capacity blocker offers only a feasible source venue and skips model calls', async () => {
  const { venues, costs } = await sources();
  const calls: string[] = [];
  const result = await runWorkshopAgent(inputs(80, 'A'), venues, costs, generator(calls));
  assert.equal(result.status, 'needs_input');
  assert.equal(result.budget.selected?.capacityPass, false);
  assert.equal(result.budget.decision?.code, 'CHOOSE_VENUE');
  if (result.budget.decision?.code === 'CHOOSE_VENUE') assert.deepEqual(result.budget.decision.options.map(option => option.id), ['B']);
  assert.deepEqual(calls, []);
});

test('Mission changes rerun dependent outputs and reuse unaffected tasks', () => {
  const attendance = planMissionInvalidation({ fields: ['attendees'] });
  assert.deepEqual(attendance.rerun, ['budget_capacity', 'event_content', 'validate_bundle']);
  assert.deepEqual(attendance.reuse, ['intake', 'agenda']);

  const topic = planMissionInvalidation({ fields: ['topic'] });
  assert.deepEqual(topic.rerun, ['agenda', 'event_content', 'validate_bundle']);
  assert.deepEqual(topic.reuse, ['intake', 'budget_capacity']);
});

test('80 attendees fit venue B at 14,400 THB but a 10,000 THB venue cost blocks the budget', async () => {
  const { venues, costs } = await sources();
  const accepted = await runWorkshopAgent(inputs(80, 'B'), venues, costs, generator());
  assert.equal(accepted.status, 'ready');
  if (accepted.status === 'ready') assert.equal(accepted.output.budget.selected?.totalThb, 14_400);

  const expensiveVenues = venues.map(venue => venue.id === 'B' ? { ...venue, fixedCostThb: 10_000 } : venue);
  const calls: string[] = [];
  const blocked = await runWorkshopAgent(inputs(80, 'B'), expensiveVenues, costs, generator(calls));
  assert.equal(blocked.status, 'needs_input');
  assert.equal(blocked.budget.selected?.totalThb, 16_400);
  assert.equal(blocked.budget.decision?.code, 'ADD_OR_CHANGE_SOURCE');
  assert.deepEqual(calls, []);
});

test('intake derives missing fields and accepts only evidence present in the cited source line', () => {
  const source = { id: 'brief-1', name: 'brief.md', version: 1, content: 'หัวข้อ: AI for Community\nกลุ่มเป้าหมาย: ผู้ดูแลชมรม' };
  const partial = validateWorkshopIntake({ facts: {
    topic: { value: 'AI for Community', evidence: [{ fileId: source.id, line: 1, quote: 'AI for Community' }] },
  } }, [source]);
  assert.equal(partial.readyForConfirmation, false);
  assert.deepEqual(partial.missingFields, ['audience', 'date', 'startTime', 'endTime', 'attendees', 'maxBudgetThb', 'venueId']);
  assert.equal(partial.questions.length, 7);

  assert.throws(() => validateWorkshopIntake({ facts: {
    topic: { value: 'Made up', evidence: [{ fileId: source.id, line: 1, quote: 'not in brief' }] },
  } }, [source]), /does not match/);
});

test('intake Agent sends source files as untrusted evidence and returns a confirmation candidate', async () => {
  const source = { id: 'brief-1', name: 'brief.md', version: 1, content: 'หัวข้อ: AI for Community' };
  const result = await runWorkshopIntakeAgent([source], {
    async generateIntake({ instructions, sources: passedSources }) {
      assert.match(instructions, /do not guess/i);
      assert.deepEqual(passedSources, [source]);
      return { facts: { topic: { value: 'AI for Community', evidence: [
        { fileId: source.id, line: 1, quote: 'AI for Community' },
      ] } } };
    },
  });
  assert.equal(result.readyForConfirmation, false);
  assert.equal(result.candidateInputs.topic, 'AI for Community');
  assert.equal(result.questions[0]?.field, 'audience');
});

test('Agent rejects overlapping agenda and bundle checks catch forged budget output', async () => {
  const { venues, costs } = await sources();
  const invalidAgenda = {
    title: 'AI for Community', objectives: ['เรียนรู้'],
    sessions: [
      { startTime: '13:00', endTime: '14:30', title: 'A', activity: 'กิจกรรม A' },
      { startTime: '14:00', endTime: '15:00', title: 'B', activity: 'กิจกรรม B' },
    ],
  };
  const calls: string[] = [];
  await assert.rejects(runWorkshopAgent(inputs(), venues, costs, generator(calls, invalidAgenda)), /Invalid agenda/);
  assert.deepEqual(calls, ['agenda']);

  const valid = await runWorkshopAgent(inputs(), venues, costs, generator());
  assert.equal(valid.status, 'ready');
  if (valid.status !== 'ready') return;
  const forged = { ...valid.output, budget: { ...valid.output.budget, selected: { ...valid.output.budget.selected!, totalThb: 1 } } };
  const validation = validateWorkshopPlan(forged, inputs(), venues, costs);
  assert.equal(validation.valid, false);
  assert.equal(validation.checks.find(check => check.code === 'BUDGET_MATCHES_SOURCE')?.passed, false);
});
