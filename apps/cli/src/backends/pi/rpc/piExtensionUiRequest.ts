import type { PermissionResult } from '@/agent/permissions/permissionResult';

import { PI_BRIDGE_USER_INPUT_MARKER_TYPE } from '../bridgeExtension/piBridgeExtensionEnv';

export type PiAskDialogQuestion = Readonly<{
  id: string;
  question: string;
  header?: string;
  options: ReadonlyArray<Readonly<{ label: string; description?: string }>>;
  multi?: boolean;
}>;

export type PiBlockingExtensionUiRequest = Readonly<{
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor' | 'ask';
  title: string;
  options?: readonly string[];
  /** omp `ask` dialog (only after `set_ask_dialog`). */
  questions?: readonly PiAskDialogQuestion[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}>;

export type PiExtensionUiResponse = Readonly<{
  type: 'extension_ui_response';
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
  answers?: ReadonlyArray<Readonly<{ id: string; selectedOptions: string[]; customInput?: string }>>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readTimeout(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Decode the session-bound bridge's submitted extension input, before diagnostic tracing. */
export function parsePiExtensionUserInput(value: unknown): string | null {
  const request = asRecord(value);
  if (request?.type !== 'extension_ui_request' || request.method !== 'notify' || typeof request.message !== 'string') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(request.message);
  } catch {
    return null;
  }
  const record = asRecord(payload);
  return record?.type === PI_BRIDGE_USER_INPUT_MARKER_TYPE && typeof record.text === 'string' && record.text.length > 0
    ? record.text
    : null;
}

function parseAskDialogRequest(id: string, request: Record<string, unknown>): PiBlockingExtensionUiRequest | null {
  if (!Array.isArray(request.questions) || request.questions.length === 0) return null;
  const questions: PiAskDialogQuestion[] = [];
  for (const raw of request.questions) {
    const question = asRecord(raw);
    const questionId = readString(question?.id);
    const text = readString(question?.question);
    if (!question || !questionId || !text || !Array.isArray(question.options)) return null;
    const options: Array<{ label: string; description?: string }> = [];
    for (const rawOption of question.options) {
      const option = asRecord(rawOption);
      const label = readString(option?.label);
      if (!option || !label) return null;
      const description = readString(option.description);
      options.push({ label, ...(description ? { description } : {}) });
    }
    const header = readString(question.header);
    questions.push({
      id: questionId,
      question: text,
      ...(header ? { header } : {}),
      options,
      ...(question.multi === true ? { multi: true } : {}),
    });
  }
  const timeout = readTimeout(request.timeout);
  return { id, method: 'ask', title: questions[0]!.question, questions, ...(timeout ? { timeout } : {}) };
}

export function parsePiBlockingExtensionUiRequest(value: unknown): PiBlockingExtensionUiRequest | null {
  const request = asRecord(value);
  if (request?.type !== 'extension_ui_request') return null;
  const id = readString(request.id);
  if (id && request.method === 'ask') return parseAskDialogRequest(id, request);
  const title = readString(request.title);
  const method = request.method;
  const timeout = method === 'editor' ? null : readTimeout(request.timeout);
  if (
    !id
    || !title
    || (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor')
  ) return null;

  if (method === 'select') {
    if (!Array.isArray(request.options)) return null;
    const options = request.options.map(readString);
    if (options.some((option) => option === null) || options.length === 0) return null;
    return { id, method, title, options: options as string[], ...(timeout ? { timeout } : {}) };
  }
  if (method === 'confirm') {
    return {
      id,
      method,
      title,
      ...(readString(request.message) ? { message: readString(request.message)! } : {}),
      ...(timeout ? { timeout } : {}),
    };
  }
  if (method === 'input') {
    return {
      id,
      method,
      title,
      ...(readString(request.placeholder) ? { placeholder: readString(request.placeholder)! } : {}),
      ...(timeout ? { timeout } : {}),
    };
  }
  return { id, method, title, ...(readString(request.prefill) ? { prefill: readString(request.prefill)! } : {}) };
}

export function buildPiExtensionAskUserQuestionInput(request: PiBlockingExtensionUiRequest): unknown {
  if (request.method === 'ask') {
    return {
      questions: (request.questions ?? []).map((question) => ({
        id: question.id,
        question: question.question,
        header: question.header ?? 'OMP',
        multiSelect: question.multi === true,
        options: question.options.map((option) => ({ label: option.label, description: option.description ?? '' })),
        // omp always offers free text beside the listed options.
        freeform: { allowEmpty: true },
      })),
    };
  }
  if (request.method === 'select') {
    return {
      questions: [{
        id: request.id,
        question: request.title,
        header: 'Pi',
        multiSelect: false,
        options: (request.options ?? []).map((label) => ({ label, description: '' })),
      }],
    };
  }
  if (request.method === 'confirm') {
    return {
      questions: [{
        id: request.id,
        question: request.message ? `${request.title}\n\n${request.message}` : request.title,
        header: 'Pi',
        multiSelect: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      }],
    };
  }
  return {
    questions: [{
      id: request.id,
      question: request.title,
      header: 'Pi',
      multiSelect: false,
      options: [],
      freeform: {
        ...(request.method === 'input' && request.placeholder ? { placeholder: request.placeholder } : {}),
        ...(request.method === 'editor' && request.prefill ? { initialValue: request.prefill } : {}),
        ...(request.method === 'editor' ? { multiline: true } : {}),
        allowEmpty: true,
      },
    }],
  };
}

function readSingleAnswer(result: PermissionResult): string | null {
  if (!result.answers) return null;
  for (const answers of Object.values(result.answers)) {
    const answer = answers[0];
    if (typeof answer === 'string') return answer;
  }
  return null;
}

export function buildPiExtensionUiResponse(
  request: PiBlockingExtensionUiRequest,
  result: PermissionResult,
): PiExtensionUiResponse {
  if (!result.decision.startsWith('approved')) {
    return { type: 'extension_ui_response', id: request.id, cancelled: true };
  }
  if (request.method === 'ask') return buildAskDialogResponse(request, result);
  const answer = readSingleAnswer(result);
  if (answer === null) return { type: 'extension_ui_response', id: request.id, cancelled: true };
  if (request.method === 'confirm') {
    return { type: 'extension_ui_response', id: request.id, confirmed: answer.toLowerCase() === 'yes' };
  }
  if (request.method === 'select' && answer.trim().length === 0) {
    return { type: 'extension_ui_response', id: request.id, cancelled: true };
  }
  return { type: 'extension_ui_response', id: request.id, value: answer };
}

function buildAskDialogResponse(request: PiBlockingExtensionUiRequest, result: PermissionResult): PiExtensionUiResponse {
  const questions = request.questions ?? [];
  const answered = result.answers ? questions.map((question) => result.answers?.[question.question] ?? result.answers?.[question.id]) : [];
  if (answered.length !== questions.length || answered.some((answer) => !Array.isArray(answer))) {
    return { type: 'extension_ui_response', id: request.id, cancelled: true };
  }
  return {
    type: 'extension_ui_response',
    id: request.id,
    answers: questions.map((question, index) => {
      const labels = new Set(question.options.map((option) => option.label));
      const values = (answered[index] as string[]).filter((value): value is string => typeof value === 'string');
      const selectedOptions = values.filter((value) => labels.has(value));
      const custom = values.filter((value) => !labels.has(value)).join('\n');
      return {
        id: question.id,
        selectedOptions,
        ...(custom ? { customInput: custom } : {}),
      };
    }),
  };
}

export type PiToolApprovalRequest = Readonly<{
  id: string;
  toolName: string;
  prompt: string;
  /** Exact option labels as omp offered them; the last is always `Deny`. */
  options: readonly string[];
}>;

const OMP_APPROVAL_DENY_LABEL = 'Deny';
const OMP_APPROVAL_TOOL_TITLE_PATTERN = /^Allow tool:\s*(\S+)/u;

/**
 * omp (no approval dialog on RPC hosts) asks for tool approval as a `select` whose options end with
 * `Deny` (`approvalChoiceLabels` in oh-my-pi tools/approval.ts). Only the caller knows whether a
 * tool call can be pending; any other select stays a normal question.
 */
export function parsePiToolApprovalSelect(request: PiBlockingExtensionUiRequest): PiToolApprovalRequest | null {
  if (request.method !== 'select' || !request.options || request.options.length < 2) return null;
  if (request.options[request.options.length - 1] !== OMP_APPROVAL_DENY_LABEL) return null;
  return {
    id: request.id,
    toolName: OMP_APPROVAL_TOOL_TITLE_PATTERN.exec(request.title)?.[1] ?? 'tool',
    prompt: request.title,
    options: request.options,
  };
}

// `Approve Once` is the once-label only beside remembered grants, where bare `Approve` is a grant.
const OMP_APPROVE_ONCE_LABELS = ['Approve Once', 'Approve'] as const;
const OMP_APPROVE_SESSION_LABEL_PATTERN = /^Approve .+ for this session$/u;

/** The exact option label answering an approval; anything not explicitly approved is `Deny`. */
export function buildPiToolApprovalResponse(
  request: PiToolApprovalRequest,
  result: PermissionResult,
): PiExtensionUiResponse {
  const deny: PiExtensionUiResponse = { type: 'extension_ui_response', id: request.id, value: OMP_APPROVAL_DENY_LABEL };
  if (result.decision !== 'approved' && result.decision !== 'approved_for_session'
    && result.decision !== 'approved_execpolicy_amendment') return deny;
  const once = OMP_APPROVE_ONCE_LABELS.find((label) => request.options.includes(label));
  const session = result.decision === 'approved_for_session'
    ? request.options.find((option) => OMP_APPROVE_SESSION_LABEL_PATTERN.test(option))
    : undefined;
  const label = session ?? once;
  return label ? { type: 'extension_ui_response', id: request.id, value: label } : deny;
}
