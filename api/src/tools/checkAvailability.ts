import { getAvailableSlots } from '../services/googleCalendar';
import { slotCache } from './state';

export async function checkAvailability(
  clinicId: string,
  callId: string,
  parameters: any
): Promise<string> {
  const requestedDate = new Date(parameters.date + 'T00:00:00+05:30');
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const diffDays = Math.floor(
    (requestedDate.getTime() - nowIST.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays > 7) {
    const callBackDate = new Date(requestedDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const callBackReadable = callBackDate.toLocaleDateString('en-IN', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
    return `Date is more than 7 days away. Say: "We only book up to a week in advance. Please call us back around ${callBackReadable} and we will get you sorted."`;
  }

  const slots = await getAvailableSlots(clinicId, parameters.date);
  slots.sort((a, b) => {
    const [aH, aM] = a.start.split(':').map(Number);
    const [bH, bM] = b.start.split(':').map(Number);
    return (aH * 60 + aM) - (bH * 60 + bM);
  });

  if (slots.length === 0) {
    return `No slots on ${parameters.date}. Ask patient to choose another date.`;
  }

  slotCache[callId] = {
    date: parameters.date,
    slots: slots.map(s => ({ start: s.start, label: s.label })),
  };

  const first4 = slots.slice(0, 4).map(s => s.label).join(', ');
  const lastSlot = slots[slots.length - 1].label;
  const total = slots.length;

  return `${total} slots on ${parameters.date}. First 4: ${first4}.${total > 4 ? ` More up to ${lastSlot}.` : ''} Read first 4 naturally. Use validateSlot for specific time requests.`;
}