import { exampleEvent, exampleState } from '../../fixtures/workshop/example.js';
import { missionApi } from './api.js';
import { renderPublicEvent } from './public-event.js';
import { renderWorkspace } from './workspace.js';

const feedback = document.getElementById('feedback')!;
function showSample(): void {
  renderWorkspace(exampleState);
  renderPublicEvent(exampleEvent);
  feedback.textContent = 'กำลังแสดง fixture สำหรับออกแบบ UI — ไม่มีการเรียก AI หรือบันทึก DB';
}
document.getElementById('load-sample')!.addEventListener('click', showSample);
document.getElementById('create-form')!.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const data = new FormData(form);
  button.disabled = true;
  try {
    const state = await missionApi.createMission({ title: String(data.get('title') ?? '').trim(), goal: String(data.get('goal') ?? '').trim() });
    renderWorkspace(state);
    feedback.textContent = 'โหลด Mission จาก API แล้ว';
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'สร้าง Mission ไม่สำเร็จ';
  } finally { button.disabled = false; }
});
showSample();
