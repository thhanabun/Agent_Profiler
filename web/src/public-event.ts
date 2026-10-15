import type { PublishedEvent } from '../../mission/contracts.js';

export function renderPublicEvent(event: PublishedEvent): void {
  document.getElementById('event-title')!.textContent = event.topic;
  document.getElementById('event-description')!.textContent = event.description;
  document.getElementById('event-details')!.textContent =
    `${event.date} · ${event.startTime}–${event.endTime} (Asia/Bangkok) · ${event.venueName}`;
  document.getElementById('event-seats')!.textContent = `${event.registrationCount} / ${event.capacity} คน`;
  // TODO: separate public route; submit with stable clientRequestId + seenBundleId.
  // Show success only after the backend returns a committed receipt.
}
