import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

export async function sendSMS(to: string, body: string): Promise<void> {
  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to,
    });
    console.log(`SMS sent ✓ to ${to} — SID: ${message.sid}`);
  } catch (err: any) {
    console.error(`SMS failed to ${to}:`, err?.message);
    throw err;
  }
}