import type { MissionState } from '../../mission/contracts.js';

export function renderWorkspace(state: MissionState): void {
  const { mission } = state;
  document.getElementById('mission-summary')!.textContent =
    `${mission.title} · revision ${mission.revision} · ${mission.executionState} · published: ${mission.publishedBundleId ?? 'ยังไม่มี'}`;
  document.getElementById('inputs-preview')!.textContent = JSON.stringify(mission.inputs, null, 2);
  const files = document.getElementById('files')!;
  files.replaceChildren();
  for (const file of state.files) {
    const item = document.createElement('li');
    item.textContent = `${file.name} · v${file.version}`;
    files.append(item);
  }
  const tasks = document.getElementById('tasks')!;
  tasks.replaceChildren();
  for (const task of state.tasks) {
    const item = document.createElement('li');
    item.textContent = `${task.key}: ${task.status}`;
    tasks.append(item);
  }
  // TODO: render validated artifact schemas, decisions and revision-aware controls.
}
