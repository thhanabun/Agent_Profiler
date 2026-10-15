import { setTimeout } from 'node:timers/promises';
import type { Runner } from './adapters.js';

// Simulation is explicit and never starts a harness or writes into the target project.
export const runDemo: Runner = async input => {
  const sessionId = input.sessionId ?? `demo-${input.profile.manifest.id}`;
  input.onEvent({ kind: 'session', text: '', sessionId });
  if (input.schema) {
    await setTimeout(450, undefined, { signal: input.signal });
    const ids = input.workerProfileIds ?? ['implement', 'ui'];
    const builder = ids.includes('implement') ? 'implement' : ids[0];
    const designer = ids.includes('ui') ? 'ui' : ids[1] ?? builder;
    const structured = {
      summary: 'SIMULATED PLAN · Preview the selected team with a fixed foundation/interface/integration flow. No models or project edits run in demo mode.',
      tasks: builder ? [
        { id: 'foundation', title: 'Implement the foundation', profileId: builder, reason: 'First selected worker in this simulated flow.',
          goal: 'Implement the requested functionality and document the integration points.', dependsOn: [], acceptance: ['The requested flow and its API contract are documented.'] },
        { id: 'interface', title: 'Refine the interface', profileId: designer!, reason: 'Second selected worker, or reuse the first worker.',
          goal: 'Design a responsive interface while preserving the existing functionality.', dependsOn: ['foundation'], acceptance: ['Responsive layout and states preserve the API contract.'] },
        { id: 'integration', title: 'Bring the changes together', profileId: builder, reason: 'Resume the first worker with the UI handoff.',
          goal: 'Inspect the designer handoff and finish the requested integration.', dependsOn: ['interface'], acceptance: ['The specialist handoffs are reconciled and remaining work is stated.'] },
      ] : [],
    };
    return { text: JSON.stringify(structured), sessionId, structured };
  }
  input.onEvent({ kind: 'activity', text: `SIMULATION · ${input.profile.manifest.name} is reading the handoff` });
  const text = input.profile.manifest.id === 'ui'
    ? 'SIMULATED DESIGNER REPORT\nWould refine typography, spacing, mobile layout and keyboard focus using ui-craft. Would preserve the implementation contract and return the changed components.\nNo files were changed; no model was called.'
    : input.sessionId
      ? 'SIMULATED BUILDER RETURN\nWould resume the original native session, read the Designer handoff and connect the interface to the application logic.\nNo files were changed; no checks were run.'
      : 'SIMULATED BUILDER REPORT\nWould implement the requested foundation, define component/API contracts and pass the current work to Designer.\nNo files were changed; no model was called.';
  for (const chunk of text.match(/.{1,38}(?:\n|$)?/g) ?? []) {
    await setTimeout(80, undefined, { signal: input.signal });
    input.onEvent({ kind: 'text', text: chunk });
  }
  return { text, sessionId };
};
