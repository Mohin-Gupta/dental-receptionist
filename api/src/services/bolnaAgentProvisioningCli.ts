/**
 * One-off (or re-run-to-update) operator script that creates or updates the
 * shared Bolna agent's tools/prompt via buildBolnaAgentConfig(). This is
 * deliberately separate from platformBolnaProvisioningCli.ts (which binds an
 * already-existing agent + phone number to a clinic), mirroring how this
 * codebase never creates Vapi assistants via its own CLI either — defining
 * "the assistant's brain" (voice, LLM, prompt) is a thoughtful, mostly
 * one-time decision; binding a number to it is a frequent, mechanical one.
 *
 * Usage:
 *   npm run bolna:provision-agent -- --agent-name "Maya" --confirm
 *   npm run bolna:provision-agent -- --agent-id <existing-id> --confirm
 */
import 'dotenv/config';
import { z } from 'zod';
import { buildBolnaAgentConfig } from './bolnaAgentBlueprint';
import { createBolnaAgent, getBolnaAgent, updateBolnaAgent } from './bolnaClient';
import { prisma } from '../lib/prisma';

const valueFlags = new Set(['--agent-id', '--agent-name']);
const booleanFlags = new Set(['--confirm']);

const optionsSchema = z.object({
  agentId: z.string().trim().min(1).max(200).optional(),
  agentName: z.string().trim().min(1).max(160).default('Maya'),
  confirm: z.literal(true),
}).strict();

type Options = z.infer<typeof optionsSchema>;

function camelCaseFlag(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function parseArguments(argv: string[]): Options {
  const values: Record<string, string | boolean> = { confirm: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (booleanFlags.has(flag)) {
      values[camelCaseFlag(flag)] = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values[camelCaseFlag(flag)] = value;
    index += 1;
  }
  return optionsSchema.parse(values);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const webhookBaseUrl = requiredEnv('BOLNA_WEBHOOK_BASE_URL');
  const toolSharedSecret = requiredEnv('BOLNA_WEBHOOK_SECRET');
  const maxDurationSeconds = configuredInteger('BOLNA_MAX_INBOUND_CALL_SECONDS', 900, 60, 7_200);

  const config = buildBolnaAgentConfig({
    agentName: options.agentName,
    webhookBaseUrl,
    executionWebhookUrl: `${webhookBaseUrl.replace(/\/+$/, '')}/execution`,
    toolSharedSecret,
    maxDurationSeconds,
  });

  if (options.agentId) {
    await getBolnaAgent(options.agentId); // confirms the agent exists/is ours before overwriting its tools
    await updateBolnaAgent(options.agentId, config);
    console.log('Updated existing Bolna agent', { agentId: options.agentId });
  } else {
    const { agentId } = await createBolnaAgent(config);
    console.log('Created new Bolna agent', { agentId });
    console.log(`Pass --agent-id ${agentId} next time to update this agent's tools/prompt in place.`);
  }
}

main()
  .catch((error) => {
    console.error('Bolna agent provisioning failed', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown error',
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
