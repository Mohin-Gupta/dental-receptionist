export async function placeOutboundCall(
  patientPhone: string,
  assistantId: string,
  assistantOverrides: Record<string, unknown> = {}
): Promise<string> {
  const response = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
    },
    body: JSON.stringify({
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: {
        number: patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`,
      },
      assistantId,
      assistantOverrides,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vapi outbound call failed: ${error}`);
  }

  const data = await response.json();
  console.log(`Outbound call placed ✓ callId: ${data.id}`);
  return data.id;
}