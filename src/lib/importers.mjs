import { Decompress } from 'fzstd';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const SOURCES = new Set(['codex', 'deepseek']);
const ROLES = new Set(['user', 'assistant', 'tool']);
const CATEGORIES = new Set(['project', 'study', 'knowledge']);
const CHECKPOINT_KINDS = new Set(['question', 'decision', 'insight', 'verification']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
export const PARSER_VERSION = 3;

/** @param {string} value */
function hash(value) {
  let result = 14695981039346656037n;
  for (let i = 0; i < value.length; i += 1) {
    result = BigInt.asUintN(64, (result ^ BigInt(value.charCodeAt(i))) * 1099511628211n);
  }
  return result.toString(36);
}

/** @param {unknown} value @param {string} fallback */
function id(value, fallback) {
  const original = typeof value === 'string' && value ? value : fallback;
  return SAFE_ID.test(original) ? original : `item-${hash(original)}`;
}

/** @param {unknown} value */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function date(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : null;
  const parsed = new Date(numeric === null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function sourceInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0);
}

function repositoryUrl(value) {
  if (!/^(?:https?|ssh):\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'ssh:') url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function rawOrigin(rawId, sequence, line) {
  return {
    ...(typeof rawId === 'string' && rawId ? { id: rawId } : {}),
    ...(sourceInteger(sequence) ? { sequence } : {}),
    line,
  };
}

/** @param {unknown} value @param {string[]} [warnings] */
function textContent(value, warnings = []) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (!Array.isArray(value)) {
    warnings.push('部分内容不是已支持的文本结构，已保留占位；完整内容请回看原始记录。');
    return '[未支持的内容结构，请查看原始记录]';
  }
  return value.flatMap((block) => {
    if (!object(block)) {
      warnings.push('部分内容块结构无效，已保留占位；完整内容请回看原始记录。');
      return ['[未支持的内容块，请查看原始记录]'];
    }
    if (['text', 'input_text', 'output_text'].includes(block.type) && typeof block.text === 'string') {
      return [block.text];
    }
    if (['reasoning', 'tool-call'].includes(block.type)) return [];
    if (['image', 'image_url', 'input_image'].includes(block.type)) {
      warnings.push('图片附件仅保留占位，未复制图片数据；完整内容请保留原始记录。');
      return ['[图片附件，请查看原始记录]'];
    }
    if (['file', 'input_file', 'document', 'audio', 'input_audio', 'video'].includes(block.type)) {
      warnings.push('文件、音频或视频附件仅保留占位；完整内容请保留原始记录。');
      return ['[文件或媒体附件，请查看原始记录]'];
    }
    const blockType = typeof block.type === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(block.type) ? block.type : 'unknown';
    warnings.push(`存在未支持的 ${blockType} 内容块，已保留占位；完整内容请回看原始记录。`);
    return [`[未支持的内容块：${blockType}，请查看原始记录]`];
  }).join('\n');
}

function mirrorKey(role, content, timestamp) {
  const normalizedTime = date(timestamp);
  return normalizedTime ? `${role}:${normalizedTime}:${hash(content)}` : null;
}

/** @param {string} line */
function incompleteJson(line) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of line) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
  return quoted || depth > 0;
}

/** @param {string} text */
function jsonLines(text) {
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
    throw new Error('记录展开后超过 64 MB，请拆分后导入。');
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lastIndex = lines.findLastIndex((line) => line.trim());
  const warnings = [];
  const rows = [];
  const lineNumbers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!object(row)) throw new Error('record');
      rows.push(row);
      lineNumbers.push(index + 1);
    } catch {
      if (index === lastIndex && !/\n\s*$/.test(text) && incompleteJson(line)) {
        warnings.push(`第 ${index + 1} 行尚未写完，已保留此前完整记录。`);
      } else {
        throw new Error(`第 ${index + 1} 行不是有效的 JSON 记录。`);
      }
    }
  }
  if (!rows.length) throw new Error('文件中没有完整的会话记录。');
  return { rows, warnings, lineNumbers };
}

/** @param {'codex'|'deepseek'} source @param {Array<Record<string, any>>} rows @param {string[]} warnings */
function sessionState(source, rows, warnings) {
  return {
    source,
    rawId: '',
    startedAt: null,
    updatedAt: null,
    currentModel: null,
    models: new Set(),
    messages: [],
    messageIndexes: new Map(),
    calls: new Map(),
    warnings,
    seed: JSON.stringify(rows[0]),
    provenance: {
      format: source === 'codex' ? 'codex-rollout' : 'deepseek-session',
      formatVersion: null,
      parserVersion: PARSER_VERSION,
      eventCount: rows.length,
    },
  };
}

function touch(state, timestamp) {
  const normalized = date(timestamp);
  if (!normalized) return;
  if (!state.startedAt || normalized < state.startedAt) state.startedAt = normalized;
  if (!state.updatedAt || normalized > state.updatedAt) state.updatedAt = normalized;
}

function append(state, { rawId, fallbackId, role, content, timestamp, model = state.currentModel, toolName, callId, origin }) {
  const messageId = id(rawId, fallbackId ?? `${state.source}-${state.messages.length}-${hash(`${role}:${content}`)}`);
  if (!content.trim()) return;
  if (rawId && !SAFE_ID.test(rawId)) state.warnings.push('部分源消息标识已转换成稳定链接标识；精确回溯仍需保留原始记录。');
  const normalizedTime = date(timestamp);
  const normalizedModel = typeof model === 'string' && model ? model : null;
  if (normalizedModel) state.models.add(normalizedModel);
  const message = {
    id: messageId,
    role,
    content,
    timestamp: normalizedTime,
    model: normalizedModel,
    ...(toolName ? { toolName } : {}),
    ...(callId ? { callId } : {}),
    ...(origin ? { origin } : {}),
  };
  const existingIndex = state.messageIndexes.get(messageId);
  if (existingIndex === undefined) {
    state.messageIndexes.set(messageId, state.messages.length);
    state.messages.push(message);
  } else if (state.messages[existingIndex].content !== content) {
    state.messages[existingIndex] = message;
    state.warnings.push('同一消息标识出现后续内容更新，已保留该消息的最新内容；修改前的片段仍在原始记录中。');
  }
  touch(state, timestamp);
}

function finish(state) {
  if (!state.messages.length) throw new Error('未找到可展示的对话消息；系统指令和内部推理不作为轨迹正文。');
  const sessionId = id(state.rawId, `${state.source}-${hash(state.seed)}`);
  return {
    id: sessionId,
    source: state.source,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    models: [...state.models],
    messages: state.messages.map((message) => ({
      ...message,
      id: id(`${state.source}-${sessionId}-${message.id}`, `${state.source}-${hash(`${sessionId}:${message.id}`)}`),
      ...(message.origin ? { origin: validateOrigin(message.origin, 'message.origin') } : {}),
    })),
    warnings: [...new Set(state.warnings)],
    provenance: validateProvenance({
      ...state.provenance,
      ...(state.provenance.cwd || !state.contextCwd ? {} : { cwd: state.contextCwd }),
    }, 'session.provenance', state.source),
  };
}

/** Parse a Codex rollout without exporting system/developer instructions or internal reasoning.
 * @param {string} text
 * @returns {import('./types').Session}
 */
export function parseCodex(text) {
  const { rows, warnings, lineNumbers } = jsonLines(text);
  if (!rows.some((row) => row.type === 'session_meta' || row.type === 'response_item')) {
    throw new Error('未识别到 Codex 会话结构。');
  }
  const state = sessionState('codex', rows, warnings);
  const canonicalIds = new Set();
  const mirrors = new Map();
  let hasCanonical = false;
  for (const row of rows) {
    const payload = row.payload;
    if (row.type !== 'response_item' || !object(payload) || payload.type !== 'message' || !['user', 'assistant'].includes(payload.role) || payload.phase === 'analysis') continue;
    hasCanonical = true;
    if (typeof payload.id === 'string') canonicalIds.add(payload.id);
    const key = mirrorKey(payload.role, textContent(payload.content), row.timestamp);
    if (key) mirrors.set(key, (mirrors.get(key) ?? 0) + 1);
  }
  for (const [rowIndex, row] of rows.entries()) {
    const payload = object(row.payload) ? row.payload : {};
    touch(state, row.timestamp);
    if (row.type === 'session_meta') {
      if (typeof payload.id === 'string') state.rawId = payload.id;
      state.provenance = {
        format: 'codex-rollout',
        formatVersion: null,
        parserVersion: PARSER_VERSION,
        eventCount: rows.length,
        ...(typeof payload.id === 'string' ? { sourceId: payload.id } : {}),
        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
        ...(typeof payload.cli_version === 'string' ? { appVersion: payload.cli_version } : {}),
        ...(typeof payload.parent_thread_id === 'string' ? { parentSessionId: payload.parent_thread_id } : typeof payload.forked_from_id === 'string' ? { parentSessionId: payload.forked_from_id } : {}),
      };
      if (object(payload.git)) {
        const remoteUrl = typeof payload.git.repository_url === 'string' ? repositoryUrl(payload.git.repository_url) : undefined;
        const git = {
          ...(typeof payload.git.commit_hash === 'string' ? { commit: payload.git.commit_hash } : {}),
          ...(typeof payload.git.branch === 'string' ? { branch: payload.git.branch } : {}),
          ...(remoteUrl ? { remoteUrl } : {}),
        };
        if (Object.keys(git).length) state.provenance.git = git;
      }
      touch(state, payload.timestamp);
      if (typeof payload.model === 'string') state.currentModel = payload.model;
    } else if (row.type === 'turn_context') {
      if (!state.contextCwd && typeof payload.cwd === 'string') state.contextCwd = payload.cwd;
      if (typeof payload.model === 'string' && payload.model) {
        state.currentModel = payload.model;
        state.models.add(payload.model);
      }
    } else if (row.type === 'compacted') {
      state.warnings.push('源会话包含上下文压缩；已保留文件中仍可读取的原始消息。');
    } else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
      const role = payload.type === 'user_message' ? 'user' : 'assistant';
      const content = textContent(payload.message, state.warnings);
      const key = mirrorKey(role, content, row.timestamp);
      if (typeof payload.id === 'string' && canonicalIds.has(payload.id)) continue;
      if (key && (mirrors.get(key) ?? 0) > 0) {
        mirrors.set(key, mirrors.get(key) - 1);
        continue;
      }
      if (hasCanonical && content.trim()) state.warnings.push('部分消息仅存在于可见事件中，已按原顺序保留；没有共同标识或时间的镜像可能重复。');
      append(state, {
        rawId: payload.id,
        fallbackId: `event-${rowIndex}-${hash(`${role}:${content}`)}`,
        role,
        content,
        timestamp: row.timestamp,
        origin: rawOrigin(payload.id, undefined, lineNumbers[rowIndex]),
      });
    } else if (row.type === 'response_item') {
      if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role) && payload.phase !== 'analysis') {
        append(state, {
          rawId: payload.id,
          fallbackId: `response-${rowIndex}-${hash(JSON.stringify(payload))}`,
          role: payload.role,
          content: textContent(payload.content, state.warnings),
          timestamp: row.timestamp,
          origin: rawOrigin(payload.id, undefined, lineNumbers[rowIndex]),
        });
      } else if (['function_call', 'custom_tool_call'].includes(payload.type)) {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
        const toolName = typeof payload.name === 'string' ? payload.name : 'tool';
        state.calls.set(callId, { toolName, model: state.currentModel });
        append(state, {
          rawId: payload.id || `${callId || hash(JSON.stringify(payload))}-call`,
          role: 'tool',
          content: typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : '',
          timestamp: row.timestamp,
          toolName,
          callId,
          origin: rawOrigin(payload.id, undefined, lineNumbers[rowIndex]),
        });
      } else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
        const call = state.calls.get(callId);
        append(state, {
          rawId: payload.id || `${callId || hash(JSON.stringify(payload))}-result`,
          role: 'tool',
          content: object(payload.output) ? JSON.stringify(payload.output) : textContent(payload.output, state.warnings),
          timestamp: row.timestamp,
          model: call?.model ?? state.currentModel,
          toolName: call?.toolName ?? 'tool',
          callId,
          origin: rawOrigin(payload.id, undefined, lineNumbers[rowIndex]),
        });
      }
    }
  }
  return finish(state);
}

/** Parse DeepSeek Harness v4 surface events, not model-only inbox snapshots.
 * @param {string} text
 * @returns {import('./types').Session}
 */
export function parseDeepSeek(text) {
  const { rows, warnings, lineNumbers } = jsonLines(text);
  const state = sessionState('deepseek', rows, warnings);
  let recognized = false;
  let hasHeader = false;
  let eventCount = 0;
  let lastSequence = -1;
  let sequenceIsContiguous = true;
  for (const [rowIndex, row] of rows.entries()) {
    if (typeof row.id === 'string' && row.createdAt !== undefined && row.version !== undefined) {
      if (row.version !== 4) throw new Error(`暂不支持 DeepSeek harness 会话版本 ${row.version}，当前支持 v4。`);
      recognized = true;
      hasHeader = true;
      state.rawId = row.id;
      state.provenance = {
        format: 'deepseek-session',
        formatVersion: row.version,
        parserVersion: PARSER_VERSION,
        sourceId: row.id,
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
        ...(typeof row.parentSession === 'string' ? { parentSessionId: row.parentSession } : {}),
      };
      touch(state, row.createdAt);
      if (row.parentSession) state.warnings.push('此会话有父会话；当前导入仅包含本文件中的消息。');
      continue;
    }
    eventCount += 1;
    if (!sourceInteger(row.seq) || row.seq !== lastSequence + 1) sequenceIsContiguous = false;
    if (sourceInteger(row.seq)) lastSequence = row.seq;
    if (typeof row.type !== 'string') continue;
    if (row.type.startsWith('agent/') || row.type.startsWith('assistant/') || row.type === 'user/message' || row.type === 'tool/result') {
      recognized = true;
    }
    touch(state, row.time);
    if (row.type === 'assistant/attempt') state.warnings.push('源文件包含模型尝试或重试事件；内部流式片段不作为独立消息，未完成尝试需回看原始记录。');
    const supportedSurface = ['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'].includes(row.type);
    if (row.surfaceOp !== undefined && !supportedSurface) {
      state.warnings.push('存在未支持的可见事件，尚未转换成正文；完整内容请查看原始记录。');
      continue;
    }
    if (supportedSurface && row.surfaceOp === undefined) {
      state.warnings.push('部分消息事件缺少 surfaceOp 可见性标记，未转换成正文；请查看原始记录。');
      continue;
    }
    if (row.surfaceOp && row.surfaceOp !== 'append') {
      if (object(row.surfaceOp) && row.surfaceOp.op === 'replace') {
        state.warnings.push('源会话包含上下文替换；轨迹保留原始可见消息，不重复导入模型上下文副本。');
      } else state.warnings.push('部分可见事件的 surfaceOp 标记不受支持，已跳过；完整内容请查看原始记录。');
      continue;
    }
    if (row.surfaceOp !== 'append' || !['user/message', 'assistant/message', 'tool/result'].includes(row.type)) continue;
    const data = object(row.data) ? row.data : {};
    const message = row.type === 'user/message' ? data : object(data.message) ? data.message : null;
    if (!message) {
      state.warnings.push('部分可见事件缺少消息正文，无法转换；完整内容请查看原始记录。');
      continue;
    }
    const role = row.type === 'user/message' ? 'user' : row.type === 'tool/result' ? 'tool' : 'assistant';
    const source = object(message.source) ? message.source : {};
    const model = source.kind === 'model' && typeof source.model === 'string' ? source.model : null;
    if (model) state.currentModel = model;
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : typeof source.callId === 'string' ? source.callId : '';
    const call = state.calls.get(callId);
    append(state, {
      rawId: message.id,
      role,
      fallbackId: `event-${row.seq ?? hash(JSON.stringify(row))}`,
      content: textContent(message.content, state.warnings),
      timestamp: row.time,
      model: role === 'user' ? null : model ?? call?.model ?? null,
      toolName: role === 'tool' ? call?.toolName ?? 'tool' : undefined,
      callId: role === 'tool' ? callId : undefined,
      origin: rawOrigin(message.id, row.seq, lineNumbers[rowIndex]),
    });
    if (role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!object(block) || block.type !== 'tool-call') continue;
        const toolCallId = typeof block.id === 'string' ? block.id : '';
        const toolName = typeof block.name === 'string' ? block.name : 'tool';
        state.calls.set(toolCallId, { toolName, model });
        append(state, {
          rawId: `${toolCallId || message.id}-call`,
          role: 'tool',
          content: typeof block.arguments === 'string' ? block.arguments : '',
          timestamp: row.time,
          model,
          toolName,
          callId: toolCallId,
          origin: rawOrigin(block.id, row.seq, lineNumbers[rowIndex]),
        });
      }
    }
  }
  if (!recognized) throw new Error('未识别到 DeepSeek harness v4 会话结构。');
  if (!hasHeader) throw new Error('缺少 DeepSeek harness v4 会话头，无法确认来源格式版本。');
  state.provenance.eventCount = eventCount;
  if (sequenceIsContiguous) state.provenance.lastSequence = lastSequence;
  else state.warnings.push('源事件序号缺失或不连续，已保留文件顺序，未声明可靠的末尾序号。');
  return finish(state);
}

function requiredString(value, path, max = MAX_TEXT_BYTES) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${path} 必须是有效文本。`);
  return value;
}

function requiredId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${path} 必须是可用于链接的唯一标识。`);
  return value;
}

function requiredDate(value, path) {
  if (value === null) return null;
  if (typeof value !== 'string' || !date(value)) throw new Error(`${path} 必须是 ISO 时间或 null。`);
  return date(value);
}

function stringArray(value, path) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${path} 必须是文本数组。`);
  return [...value];
}

function requiredInteger(value, path, minimum = 0) {
  if (!sourceInteger(value, minimum)) throw new Error(`${path} 必须是有效整数。`);
  return value;
}

function validateOrigin(value, path) {
  if (!object(value)) throw new Error(`${path} 必须是来源定位对象。`);
  return {
    ...(value.id === undefined ? {} : { id: requiredString(value.id, `${path}.id`, 2000) }),
    ...(value.sequence === undefined ? {} : { sequence: requiredInteger(value.sequence, `${path}.sequence`) }),
    ...(value.line === undefined ? {} : { line: requiredInteger(value.line, `${path}.line`, 1) }),
  };
}

function validateProvenance(value, path, source) {
  if (!object(value) || !['codex-rollout', 'deepseek-session'].includes(value.format)) throw new Error(`${path}.format 无效。`);
  if ((source === 'codex' ? 'codex-rollout' : 'deepseek-session') !== value.format) throw new Error(`${path}.format 与会话来源不匹配。`);
  const output = {
    format: value.format,
    formatVersion: value.formatVersion === null ? null : requiredInteger(value.formatVersion, `${path}.formatVersion`),
    parserVersion: requiredInteger(value.parserVersion, `${path}.parserVersion`, 1),
  };
  for (const [key, max] of [['sourceId', 2000], ['cwd', 32768], ['parentSessionId', 2000], ['appVersion', 500], ['repoId', 500]]) {
    if (value[key] !== undefined) output[key] = requiredString(value[key], `${path}.${key}`, max);
  }
  for (const key of ['eventCount', 'lastSequence']) {
    if (value[key] !== undefined) output[key] = requiredInteger(value[key], `${path}.${key}`, key === 'lastSequence' ? -1 : 0);
  }
  if (value.sha256 !== undefined) {
    if (typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256)) throw new Error(`${path}.sha256 必须是 SHA-256 摘要。`);
    output.sha256 = value.sha256.toLowerCase();
  }
  if (value.observedAt !== undefined) output.observedAt = requiredDate(requiredString(value.observedAt, `${path}.observedAt`, 100), `${path}.observedAt`);
  if (value.git !== undefined) {
    if (!object(value.git)) throw new Error(`${path}.git 必须是 Git 来源对象。`);
    const git = {};
    if (value.git.commit !== undefined) git.commit = requiredString(value.git.commit, `${path}.git.commit`, 200);
    if (value.git.branch !== undefined) git.branch = requiredString(value.git.branch, `${path}.git.branch`, 1000);
    if (value.git.remoteUrl !== undefined) {
      const remote = repositoryUrl(requiredString(value.git.remoteUrl, `${path}.git.remoteUrl`, 4000));
      if (!remote) throw new Error(`${path}.git.remoteUrl 不是有效的 Git 来源地址。`);
      git.remoteUrl = remote;
    }
    output.git = git;
  }
  return output;
}

function validateTrajectory(value, index) {
  const path = `trajectories[${index}]`;
  if (!object(value) || value.version !== 1) throw new Error(`${path} 的记录版本不受支持。`);
  if (!CATEGORIES.has(value.category)) throw new Error(`${path}.category 无效。`);
  if (!['ongoing', 'completed'].includes(value.status)) throw new Error(`${path}.status 无效。`);
  if (!Array.isArray(value.sessions) || !Array.isArray(value.checkpoints) || !Array.isArray(value.links)) {
    throw new Error(`${path} 缺少 sessions、checkpoints 或 links 数组。`);
  }
  const sessionIds = new Set();
  const messageIds = new Set();
  const sessions = value.sessions.map((session, sessionIndex) => {
    const itemPath = `${path}.sessions[${sessionIndex}]`;
    if (!object(session) || !SOURCES.has(session.source) || !Array.isArray(session.messages)) throw new Error(`${itemPath} 不是有效会话。`);
    const sessionId = requiredId(session.id, `${itemPath}.id`);
    const sessionKey = `${session.source}:${sessionId}`;
    if (sessionIds.has(sessionKey)) throw new Error(`${path} 包含重复会话标识。`);
    sessionIds.add(sessionKey);
    return {
      id: sessionId,
      source: session.source,
      startedAt: requiredDate(session.startedAt, `${itemPath}.startedAt`),
      updatedAt: requiredDate(session.updatedAt, `${itemPath}.updatedAt`),
      models: stringArray(session.models, `${itemPath}.models`),
      messages: session.messages.map((message, messageIndex) => {
        const messagePath = `${itemPath}.messages[${messageIndex}]`;
        if (!object(message) || !ROLES.has(message.role)) throw new Error(`${messagePath}.role 无效。`);
        const messageId = requiredId(message.id, `${messagePath}.id`);
        if (messageIds.has(messageId)) throw new Error(`${path} 包含重复消息标识。`);
        messageIds.add(messageId);
        return {
          id: messageId,
          role: message.role,
          content: requiredString(message.content, `${messagePath}.content`),
          timestamp: requiredDate(message.timestamp, `${messagePath}.timestamp`),
          model: message.model === null ? null : requiredString(message.model, `${messagePath}.model`, 300),
          ...(message.toolName === undefined ? {} : { toolName: requiredString(message.toolName, `${messagePath}.toolName`, 300) }),
          ...(message.callId === undefined ? {} : { callId: requiredString(message.callId, `${messagePath}.callId`, 500) }),
          ...(message.origin === undefined ? {} : { origin: validateOrigin(message.origin, `${messagePath}.origin`) }),
        };
      }),
      warnings: stringArray(session.warnings, `${itemPath}.warnings`),
      ...(session.provenance === undefined ? {} : { provenance: validateProvenance(session.provenance, `${itemPath}.provenance`, session.source) }),
    };
  });
  const checkpointIds = new Set();
  const checkpoints = value.checkpoints.map((checkpoint, checkpointIndex) => {
    const itemPath = `${path}.checkpoints[${checkpointIndex}]`;
    if (!object(checkpoint) || !CHECKPOINT_KINDS.has(checkpoint.kind)) throw new Error(`${itemPath}.kind 无效。`);
    const checkpointId = requiredId(checkpoint.id, `${itemPath}.id`);
    if (checkpointIds.has(checkpointId)) throw new Error(`${path} 包含重复标记标识。`);
    checkpointIds.add(checkpointId);
    if (!messageIds.has(checkpoint.messageId)) throw new Error(`${itemPath} 引用了不存在的消息。`);
    return {
      id: checkpointId,
      messageId: checkpoint.messageId,
      kind: checkpoint.kind,
      title: requiredString(checkpoint.title, `${itemPath}.title`, 500),
      body: requiredString(checkpoint.body, `${itemPath}.body`),
    };
  });
  return {
    version: 1,
    id: requiredId(value.id, `${path}.id`),
    title: requiredString(value.title, `${path}.title`, 500),
    description: requiredString(value.description, `${path}.description`),
    category: value.category,
    topic: requiredString(value.topic, `${path}.topic`, 500),
    status: value.status,
    startedAt: requiredDate(value.startedAt, `${path}.startedAt`),
    updatedAt: requiredDate(value.updatedAt, `${path}.updatedAt`),
    tags: stringArray(value.tags, `${path}.tags`),
    sessions,
    checkpoints,
    links: value.links.map((link, linkIndex) => {
      const linkPath = `${path}.links[${linkIndex}]`;
      if (!object(link)) throw new Error(`${linkPath} 不是有效链接。`);
      const href = requiredString(link.href, `${linkPath}.href`, 2000);
      if (!/^(https?:\/\/|\/(?!\/)|#)/.test(href) || /[\u0000-\u001f]/.test(href)) throw new Error(`${linkPath}.href 必须是安全的网站链接。`);
      return { title: requiredString(link.title, `${linkPath}.title`, 500), href };
    }),
    ...(value.demo === true ? { demo: true } : {}),
  };
}

function trajectoryFromSession(session) {
  const candidates = session.messages.filter((message) => message.role === 'user').map((message) => {
    const content = message.content.trim();
    // Context remains readable in the timeline, but is a poor automatic title.
    if (/^# AGENTS\.md instructions for [^\n]+\n/.test(content) || content.startsWith('<environment_context>')) return '';
    if (content.startsWith('<in-app-browser-context') || content.startsWith('# Files mentioned by the user:')) {
      const request = content.lastIndexOf('## My request:');
      if (request >= 0) return content.slice(request + '## My request:'.length).trim();
    }
    return content;
  });
  const question = candidates.find(Boolean) ?? '';
  const firstLine = question.split('\n').find((line) => line.trim()) ?? '';
  return {
    version: 1,
    id: `${session.source}-${session.id}`.slice(0, 160),
    title: firstLine ? [...firstLine.replace(/^#+\s*/, '')].slice(0, 70).join('') : '未命名轨迹',
    description: '',
    category: 'knowledge',
    topic: '未分类',
    status: 'ongoing',
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    tags: [],
    sessions: [session],
    checkpoints: [],
    links: [],
  };
}

function decode(input, filename) {
  if (typeof input === 'string') return input;
  if (!(input instanceof Uint8Array)) throw new Error('导入内容必须是文本或文件字节。');
  const compressed = /\.(?:zstd|zst)$/i.test(filename) || (input[0] === 0x28 && input[1] === 0xb5 && input[2] === 0x2f && input[3] === 0xfd);
  if (input.byteLength > (compressed ? MAX_INPUT_BYTES : MAX_TEXT_BYTES)) throw new Error(compressed ? '压缩文件超过 16 MB，请拆分后导入。' : '文件超过 64 MB，请拆分后导入。');
  let bytes = input;
  if (compressed) {
    const chunks = [];
    let total = 0;
    const stream = new Decompress((chunk) => {
      total += chunk.byteLength;
      if (total > MAX_TEXT_BYTES) throw new Error('记录展开后超过 64 MB，请拆分后导入。');
      chunks.push(chunk);
    });
    try {
      stream.push(input, true);
    } catch (error) {
      if (error instanceof Error && error.message.includes('64 MB')) throw error;
      throw new Error('无法解压 Zstandard 记录；请确认文件完整且格式受支持。');
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本。');
  }
}

/** Import Codex JSONL, DeepSeek Harness v4 JSONL/Zstandard, or an exported archive.
 * @param {string|Uint8Array} input
 * @param {string} [filename]
 * @returns {import('./types').Trajectory[]}
 */
export function parseImport(input, filename = '') {
  const text = decode(input, filename).replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('文件为空。');
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new Error('文件超过 64 MB，请拆分后导入。');
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* Raw session logs are JSONL. */ }
  if (object(parsed) && ('trajectories' in parsed || 'version' in parsed && !('createdAt' in parsed))) {
    if (parsed.version !== 1 || !Array.isArray(parsed.trajectories)) throw new Error('导出文件必须包含 version: 1 和 trajectories 数组。');
    const ids = new Set();
    return parsed.trajectories.map((value, index) => {
      const trajectory = validateTrajectory(value, index);
      if (ids.has(trajectory.id)) throw new Error('导出文件包含重复轨迹标识。');
      ids.add(trajectory.id);
      return trajectory;
    });
  }
  const { rows } = jsonLines(text);
  if (rows.some((row) => ['session_meta', 'response_item', 'turn_context'].includes(row.type))) {
    return [trajectoryFromSession(parseCodex(text))];
  }
  if (rows.some((row) => typeof row.type === 'string' && /^(?:user\/message|assistant\/|agent\/|tool\/result)/.test(row.type)) || rows.some((row) => row.createdAt !== undefined && row.version !== undefined)) {
    return [trajectoryFromSession(parseDeepSeek(text))];
  }
  throw new Error('无法识别文件。请选择 Codex JSONL、DeepSeek harness 会话文件或本站导出的 JSON。');
}
