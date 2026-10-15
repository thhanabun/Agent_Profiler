import type { MissionApi } from '../../mission/contracts.js';

async function notConnected(): Promise<never> {
  throw new Error('NOT_IMPLEMENTED: เชื่อม Mission API และ owner authentication ใน web/src/api.ts ก่อนใช้งานจริง');
}

// Backend/UI integration point. Never replace this with fake success responses.
// TODO: HTTP transport, runtime response validation, access-token injection and ApiResult errors.
export const missionApi: MissionApi = {
  listMissions: notConnected, createMission: notConnected, getMission: notConnected,
  updateMission: notConnected, startReadyTasks: notConnected, cancelMission: notConnected,
  approveAndPublish: notConnected, getPublishedEvent: notConnected,
  submitRegistration: notConnected, exportRegistrations: notConnected,
};
