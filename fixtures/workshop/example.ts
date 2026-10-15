import type { MissionState, PublishedEvent } from '../../mission/contracts.js';

// UI-only, hand-authored examples. No parsing, AI, checks, persistence or publication has run.
// The fixture hash markers are deliberately NOT real SHA-256 hashes.
export const exampleState: MissionState = {
  mission: {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'เปิดรับสมัคร AI for Community',
    goal: 'เตรียม workshop 60 คน งบไม่เกิน 15,000 บาท พร้อมหน้าเปิดรับสมัคร',
    template: 'workshop-launch',
    inputs: { topic: 'AI for Community', audience: 'ผู้ดูแลชมรมและ community', date: '2026-10-24',
      startTime: '13:00', endTime: '16:00', attendees: 60, maxBudgetThb: 15000, venueId: 'A' },
    revision: 1, runId: null, generation: 0, stopEpoch: 0, executionState: 'draft', publishedBundleId: null,
  },
  files: [
    { id: 'fixture-brief', name: 'brief.md', version: 1, contentHash: 'fixture-only' },
    { id: 'fixture-venues', name: 'venues.csv', version: 1, contentHash: 'fixture-only' },
    { id: 'fixture-costs', name: 'costs.csv', version: 1, contentHash: 'fixture-only' },
  ],
  tasks: [
    { id: 'fixture-intake', key: 'intake', status: 'ready', inputHash: 'fixture-only', dependsOn: [] },
    { id: 'fixture-budget', key: 'budget_capacity', status: 'ready', inputHash: 'fixture-only', dependsOn: ['intake'] },
    { id: 'fixture-agenda', key: 'agenda', status: 'ready', inputHash: 'fixture-only', dependsOn: ['intake'] },
    { id: 'fixture-content', key: 'event_content', status: 'ready', inputHash: 'fixture-only', dependsOn: ['budget_capacity', 'agenda'] },
    { id: 'fixture-checks', key: 'validate_bundle', status: 'ready', inputHash: 'fixture-only', dependsOn: ['budget_capacity', 'agenda', 'event_content'] },
  ],
  artifacts: [], draftBundle: null, decisions: [],
};

// Separate visual preview, NOT a published bundle or a successful registration.
export const exampleEvent: PublishedEvent = {
  slug: 'sample-ai-for-community', bundleId: 'fixture-not-published', topic: 'AI for Community',
  description: 'เรียนรู้และลงมือใช้ AI เตรียมงานสำหรับผู้ดูแลชมรมและ community',
  date: '2026-10-24', startTime: '13:00', endTime: '16:00', venueName: 'ห้อง A',
  capacity: 60, registrationCount: 0,
};

// Expected results for future domain checks; these are not computed by this template.
export const acceptanceExamples = [
  { venueId: 'A', attendees: 60, fixedCostThb: 6000, expectedTotalThb: 10800, capacityPass: true, budgetPass: true },
  { venueId: 'A', attendees: 80, fixedCostThb: 6000, expectedTotalThb: 12400, capacityPass: false, budgetPass: true },
  { venueId: 'B', attendees: 80, fixedCostThb: 8000, expectedTotalThb: 14400, capacityPass: true, budgetPass: true },
  { venueId: 'B', attendees: 80, fixedCostThb: 10000, expectedTotalThb: 16400, capacityPass: true, budgetPass: false },
] as const;
