/**
 * Builds the Bolna v2 agent_config/agent_prompts JSON that wires every
 * receptionist tool (the same business logic already used by Vapi, in
 * ../tools) to this backend as Bolna "custom_task" tools, plus a
 * transferToHuman tool that drives the human handoff through Vobiz directly
 * instead of Bolna's own (static-destination-only) Transfer Call tool.
 *
 * Key facts this file relies on, confirmed against Bolna's own docs:
 *  - Each custom function tool is configured with its OWN target url/method
 *    at setup time (tools_config.api_tools.tools[] + .tools_params{}), not a
 *    single generic webhook the way Vapi's tool-calls message works. Bolna
 *    dispatches one HTTP call per tool invocation directly to that tool's
 *    configured url.
 *  - `param` in tools_params is a JSON-STRINGIFIED template string (per
 *    Bolna's v2 OpenAPI schema for TransferCallToolParams.param), not a
 *    nested object, even though the illustrative examples in Bolna's Custom
 *    Function Calls guide show it unstringified for readability.
 *  - System variables (`to_number`, `call_sid`, `from_number`, `agent_id`)
 *    are auto-substituted into a tool's param template via `%(field)s` only
 *    if (a) they're declared as parameters on that tool and (b) referenced
 *    with `{field}` syntax somewhere in the agent's system prompt. Both are
 *    handled below for every tool.
 *  - The API response from a custom-task call is fed directly back to the
 *    LLM as the function result and narrated — no envelope/toolCallId is
 *    needed, unlike Vapi's batched tool-calls message.
 *
 * NOT CONFIRMED: the exact field names Bolna's execution/status webhook
 * payload uses for call duration and cost are still unconfirmed (only that
 * the payload matches Bolna's Get Execution API shape). Bolna's docs do
 * confirm the webhook fires from a fixed source IP, 13.203.39.153 — worth
 * allow-listing at the ingress/firewall layer once this is live.
 */

export const BOLNA_WEBHOOK_SYSTEM_VARIABLES = ['to_number', 'call_sid', 'from_number'] as const;

interface ToolParamSpec {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description: string;
}

interface ToolBlueprint {
  name: string;
  description: string;
  preCallMessage?: string;
  properties: Record<string, ToolParamSpec>;
  required: string[];
}

const SYSTEM_CONTEXT_PROPERTIES: Record<string, ToolParamSpec> = {
  to_number: {
    type: 'string',
    description:
      "The clinic's phone number that the caller dialled. This is always the {to_number} system value — never ask the caller for this.",
  },
  call_sid: {
    type: 'string',
    description:
      'The unique ID of this phone call. This is always the {call_sid} system value — never ask the caller for this.',
  },
  from_number: {
    type: 'string',
    description:
      "The caller's own phone number. This is always the {from_number} system value — never ask the caller for this.",
  },
};

const BUSINESS_TOOL_BLUEPRINTS: ToolBlueprint[] = [
  {
    name: 'checkAvailability',
    description:
      'Use this when the patient wants to know available appointment slots on a specific date, optionally for a specific doctor.',
    preCallMessage: 'Let me check what is available.',
    properties: {
      date: { type: 'string', description: 'The date to check, in YYYY-MM-DD format.' },
      doctorId: {
        type: 'string',
        description: "The doctor's internal ID, if the patient asked about a specific doctor. Leave blank otherwise.",
      },
    },
    required: ['date'],
  },
  {
    name: 'findDoctors',
    description:
      'Use this to look up which doctors at the clinic can help with a stated reason for the visit, or to list all doctors if the patient has not stated a reason.',
    preCallMessage: 'Let me see which doctor can help with that.',
    properties: {
      reason: { type: 'string', description: 'The reason for the visit the patient has given, if any.' },
    },
    required: [],
  },
  {
    name: 'validateSlot',
    description:
      'Use this to confirm a specific date and time the patient wants is still available before proceeding to confirm booking details.',
    preCallMessage: 'One moment, checking that slot.',
    properties: {
      date: { type: 'string', description: 'The requested date, in YYYY-MM-DD format.' },
      time: { type: 'string', description: "The requested time, e.g. '10:30 AM'." },
      doctorId: {
        type: 'string',
        description: "The doctor's internal ID, if a specific doctor was chosen. Leave blank otherwise.",
      },
    },
    required: ['date', 'time'],
  },
  {
    name: 'storeName',
    description:
      "Use this to record the patient's name immediately after asking them to spell it out letter by letter, to avoid mishearing names in a voice call.",
    properties: {
      letters: {
        type: 'string',
        description: "The name as spelled out by the patient, letter by letter (e.g. 'M-O-H-A-N').",
      },
    },
    required: ['letters'],
  },
  {
    name: 'confirmDetails',
    description:
      'Use this to record and read back the appointment date, time, and reason (and the patient name/phone if newly collected) for the patient to confirm before booking.',
    properties: {
      date: { type: 'string', description: 'The appointment date, in YYYY-MM-DD format.' },
      time: { type: 'string', description: "The appointment time, e.g. '10:30 AM'." },
      reason: { type: 'string', description: 'The reason for the visit.' },
      patientName: { type: 'string', description: "The patient's full name, if collected in this call." },
      patientPhone: { type: 'string', description: "The patient's phone number, if collected in this call." },
    },
    required: ['date', 'time'],
  },
  {
    name: 'requestCallerVerification',
    description:
      'Use this when the caller must be verified against an existing patient record by name before sensitive actions like cancelling or rescheduling, in order to send them a verification code.',
    properties: {
      patientName: { type: 'string', description: "The patient's full name as given by the caller." },
    },
    required: ['patientName'],
  },
  {
    name: 'verifyCallerCode',
    description: 'Use this immediately after the caller reads back the 6-digit verification code they were sent.',
    properties: {
      code: { type: 'string', description: 'The 6-digit verification code the caller read back.' },
    },
    required: ['code'],
  },
  {
    name: 'findAppointment',
    description: "Use this to look up a patient's existing upcoming appointment by name before cancelling or rescheduling it.",
    properties: {
      patientName: { type: 'string', description: "The patient's full name." },
    },
    required: ['patientName'],
  },
  {
    name: 'cancelAppointment',
    description:
      'Use this to cancel a specific appointment once its ID is known from a prior findAppointment call and the patient has confirmed they want to cancel it.',
    properties: {
      appointmentId: { type: 'string', description: 'The internal appointment ID returned by findAppointment.' },
    },
    required: ['appointmentId'],
  },
  {
    name: 'rescheduleAppointment',
    description:
      'Use this to move an existing appointment (identified via findAppointment) to a new date and time the patient has requested and that has been validated as available.',
    properties: {
      appointmentId: { type: 'string', description: 'The internal appointment ID returned by findAppointment.' },
      newDate: { type: 'string', description: 'The new date, in YYYY-MM-DD format.' },
      newTime: { type: 'string', description: "The new time, e.g. '10:30 AM'." },
      doctorId: { type: 'string', description: 'The internal doctor ID, if changing doctor. Leave blank otherwise.' },
    },
    required: ['appointmentId', 'newDate', 'newTime'],
  },
  {
    name: 'bookAppointment',
    description: 'Use this to finalize the booking after the patient has explicitly confirmed the date, time, and reason read back by confirmDetails.',
    properties: {
      doctorId: { type: 'string', description: 'The internal doctor ID, if the patient chose a specific doctor. Leave blank otherwise.' },
    },
    required: [],
  },
];

const TRANSFER_TOOL_BLUEPRINT: ToolBlueprint = {
  name: 'transferToHuman',
  description:
    'Use this whenever the caller explicitly asks to speak with a staff member, receptionist, or human, or when the request is clearly outside what you can help with on the phone.',
  preCallMessage: 'Sure, connecting you to our clinic team now.',
  properties: {
    reason: { type: 'string', description: 'A short reason for the transfer, e.g. "billing question" or "caller requested a human".' },
  },
  required: [],
};

export const BOLNA_TOOL_BLUEPRINTS: ToolBlueprint[] = [...BUSINESS_TOOL_BLUEPRINTS, TRANSFER_TOOL_BLUEPRINT];
export const BOLNA_TOOL_NAMES = BOLNA_TOOL_BLUEPRINTS.map((blueprint) => blueprint.name);

function toJsonSchemaParameters(blueprint: ToolBlueprint) {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(blueprint.properties)) {
    properties[key] = { type: spec.type, description: spec.description };
  }
  for (const [key, spec] of Object.entries(SYSTEM_CONTEXT_PROPERTIES)) {
    properties[key] = { type: spec.type, description: spec.description };
  }
  return {
    type: 'object',
    properties,
    required: [...blueprint.required, ...Object.keys(SYSTEM_CONTEXT_PROPERTIES)],
  };
}

function toBolnaTool(blueprint: ToolBlueprint) {
  return {
    name: blueprint.name,
    key: 'custom_task' as const,
    description: blueprint.description,
    ...(blueprint.preCallMessage ? { pre_call_message: blueprint.preCallMessage } : {}),
    parameters: toJsonSchemaParameters(blueprint),
  };
}

function toBolnaToolParam(blueprint: ToolBlueprint, webhookBaseUrl: string, sharedSecret: string) {
  const param: Record<string, string> = {};
  for (const key of Object.keys(blueprint.properties)) param[key] = `%(${key})s`;
  for (const key of Object.keys(SYSTEM_CONTEXT_PROPERTIES)) param[key] = `%(${key})s`;
  return {
    method: 'POST' as const,
    url: `${webhookBaseUrl.replace(/\/+$/, '')}/tools/${blueprint.name}`,
    api_token: `Bearer ${sharedSecret}`,
    param: JSON.stringify(param),
  };
}

export interface BuildBolnaAgentConfigInput {
  agentName: string;
  /** e.g. https://api.example.com/api/webhook/bolna (no trailing slash) */
  webhookBaseUrl: string;
  /** e.g. https://api.example.com/api/webhook/bolna/execution */
  executionWebhookUrl: string;
  toolSharedSecret: string;
  maxDurationSeconds: number;
  systemPrompt?: string;
  welcomeMessage?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are a warm, efficient dental clinic receptionist speaking with a patient over the phone.
Help the patient check availability, book, reschedule, cancel, or ask about appointments, and transfer them to a
human staff member if they ask for one or if their request is outside what you can help with.
Keep responses brief and natural for a voice call. Mirror the caller's language and tone, while never altering any
fact given to you by a tool result.

# Internal context — never say these values aloud to the caller
Clinic number dialled: {to_number}. Call ID: {call_sid}. Caller number: {from_number}. Agent ID: {agent_id}.`;

export function buildBolnaAgentConfig(input: BuildBolnaAgentConfigInput): Record<string, unknown> {
  const tools = BOLNA_TOOL_BLUEPRINTS.map(toBolnaTool);
  const toolsParams: Record<string, unknown> = {};
  for (const blueprint of BOLNA_TOOL_BLUEPRINTS) {
    toolsParams[blueprint.name] = toBolnaToolParam(blueprint, input.webhookBaseUrl, input.toolSharedSecret);
  }

  return {
    agent_config: {
      agent_name: input.agentName,
      agent_welcome_message: input.welcomeMessage ?? 'Thank you for calling. This is Maya, how may I help you today?',
      webhook_url: input.executionWebhookUrl,
      agent_type: 'other',
      // Confirmed against Bolna's own OpenAPI schema
      // (docs.bolna.ai/api-reference/agent/v2/patch_update): 'vobiz' is the
      // exact accepted value, and setting it auto-updates the agent's audio
      // format to 'wav' (matching the input/output format set explicitly
      // below too, redundantly but harmlessly).
      telephony_provider: 'vobiz',
      tasks: [
        {
          task_type: 'conversation',
          toolchain: {
            execution: 'sequential',
            pipelines: [['transcriber', 'llm', 'synthesizer']],
          },
          tools_config: {
            llm_agent: {
              agent_type: 'simple_llm_agent',
              agent_flow_type: 'streaming',
              llm_config: {
                provider: 'openai',
                model: 'gpt-4.1-mini',
                max_tokens: 200,
                temperature: 0.2,
              },
            },
            synthesizer: {
              provider: 'deepgram',
              provider_config: { voice: 'Asteria', model: 'aura-asteria-en' },
              stream: true,
              buffer_size: 150,
              audio_format: 'wav',
            },
            transcriber: {
              provider: 'deepgram',
              model: 'nova-3',
              language: 'en',
              stream: true,
              encoding: 'linear16',
              sampling_rate: 16000,
              endpointing: 250,
            },
            // Confirmed 'vobiz' as the exact provider value (see
            // agent_config.telephony_provider above for the primary source).
            input: { provider: 'vobiz', format: 'wav' },
            output: { provider: 'vobiz', format: 'wav' },
            api_tools: {
              tools,
              tools_params: toolsParams,
            },
          },
          task_config: {
            call_terminate: input.maxDurationSeconds,
            hangup_after_silence: 10,
          },
        },
      ],
    },
    agent_prompts: {
      task_1: {
        system_prompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      },
    },
  };
}
