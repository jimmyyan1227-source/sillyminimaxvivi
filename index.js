/**
 * SillyTavern Extension: Bilingual Dialog MiniMax TTS
 * 双语台词提取与 MiniMax TTS 语音合成播放插件
 * 
 * 适用于 SillyTavern 1.11.x 及以上版本
 * 安装路径: public/scripts/extensions/third-party/sillytavern-bilingual-minimax-tts/
 */

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'bilingual_minimax_tts';

// 旧版默认正则：升级时自动迁移，避免已保存的旧设置覆盖新版匹配规则。
const LEGACY_REGEX_PATTERN = '["“]([^"”]+)["”]\\s*[（\\(]([^\\)）]+)[\\)）]';

// 动态获取当前扩展所在的文件夹名称 (兼容 GitHub Clone 任意仓库名)
const EXTENSION_DIR = (() => {
  try {
    const urlParts = import.meta.url.split('/');
    return urlParts[urlParts.length - 2] || 'sillytavern-bilingual-minimax-tts';
  } catch {
    return 'sillytavern-bilingual-minimax-tts';
  }
})();
const DEFAULT_AI_PROMPT = `你是一个台词提取专家。请从给定的对话文本中，严格提取出所有角色的【英文原话台词】以及括号中附带的【中文翻译】。
过滤要求：
1. 彻底剔除所有旁白描写、动作描写（如 *...* ）、环境与心理活动。
2. 仅保留真正的角色对白。若台词只有英文没有中文，或只有中文，也请提取并尽量补齐对应语言。
3. 返回严格的 JSON 数组格式，不要输出任何多余的 Markdown 标记或文字：
[
  {
    "character": "角色名(若未知可填 Character)",
    "english": "英文原话",
    "chinese": "中文翻译"
  }
]`;

// 默认配置
const DEFAULT_SETTINGS = {
  enabled: true,
  auto_play: false, // 收到新消息时是否自动提取并播放
  extract_mode: 'ai', // 'ai' | 'regex'
  // 廉价 AI 接口配置 (OpenAI 兼容)
  ai_api_url: 'https://api.openai.com/v1',
  ai_api_key: '',
  ai_model: 'gpt-4o-mini',
  ai_custom_prompt: DEFAULT_AI_PROMPT,
  fallback_to_regex: true, // AI 失败时自动使用正则兜底
  // 正则模式配置
  regex_pattern: '["“]([\\s\\S]*?)(?:\\s*[（(]([^()（）]+)[）)])?["”]\\s*(?:[（(]([^()（）]+)[）)])?',
  speaker_filter: '', // 指定朗读角色；留空时朗读所有角色
  // MiniMax TTS 配置
  minimax_api_key: '',
  minimax_group_id: '',
  minimax_model: 'speech-01-turbo',
  minimax_voice_id: 'male-qn-qingse',
  minimax_speed: 1.0,
  minimax_vol: 1.0,
  minimax_pitch: 0,
  read_target: 'english', // 'english': 仅朗读英文 | 'chinese': 仅朗读中文 | 'both': 依次朗读英文+中文
  // UI 与播放配置
  show_subtitle: true,
  audio_delay_ms: 300, // 多句之间的停顿毫秒数
};

// 播放队列状态
const processingMessages = new Set();
const processedMessageLines = new Map();
const audioCache = new Map();
const diagnosticEntries = [];

const playQueue = {
  items: [],
  currentIndex: -1,
  isPlaying: false,
  audioElement: null,
  activeMessageId: null,
};

/**
 * 初始化扩展
 */
export async function init() {
  console.log(`[${MODULE_NAME}] Initializing Bilingual MiniMax TTS Extension...`);

  // 初始化设置
  extension_settings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
  if (extension_settings[MODULE_NAME].regex_pattern === LEGACY_REGEX_PATTERN) {
    extension_settings[MODULE_NAME].regex_pattern = DEFAULT_SETTINGS.regex_pattern;
  }

  // 创建单例 Audio 对象
  if (!playQueue.audioElement) {
    playQueue.audioElement = new Audio();
    playQueue.audioElement.addEventListener('ended', onAudioEnded);
    playQueue.audioElement.addEventListener('error', onAudioError);
  }

  // 加载样式与设置抽屉面板
  await loadStyles();
  await initSettingsUI();

  // 清除历史版本残留的按钮，避免继续改动每条消息卡片的排版。
  document.getElementById('bilingual-tts-bottom-launcher')?.remove();
  document.querySelectorAll('.bilingual-tts-floor-btn').forEach((button) => button.remove());

  // 注入独立悬浮球、楼层选择器与毛玻璃字幕播放器。
  injectSubtitleOverlay();
  injectFloatingLauncher();

  // 收到消息时只处理自动播放，不向任何楼层 DOM 插入控件。
  eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId) => {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled || !settings.auto_play) return;
    const context = getContext();
    const message = context.chat?.[messageId];
    if (message && !message.is_user) {
      console.log(`[${MODULE_NAME}] Auto-processing message #${messageId}`);
      try { await processMessage(messageId); } catch (err) { logDiagnostic(`自动处理楼层 ${messageId} 失败`, err.message || String(err), 'error'); showToast(`自动朗读失败：${err.message || err}`, 'error'); }
    }
  });

  console.log(`[${MODULE_NAME}] Extension loaded successfully.`);
}

/**
 * 加载自定义 CSS
 */
async function loadStyles() {
  if (document.getElementById(`${MODULE_NAME}-style`)) return;
  const link = document.createElement('link');
  link.id = `${MODULE_NAME}-style`;
  link.rel = 'stylesheet';
  link.href = `/scripts/extensions/third-party/${EXTENSION_DIR}/style.css?v=1.0.7`;
  document.head.appendChild(link);
}

/**
 * 从聊天数据构建可选的角色楼层列表。
 * 不给任何消息 DOM 增加节点，避免干扰用户自定义消息卡片美化。
 */
function getSpeakableMessages(limit = 30) {
  const chat = getContext().chat || [];
  const entries = Array.isArray(chat) ? chat.map((message, index) => [String(index), message]) : Object.entries(chat);
  return entries
    .filter(([, message]) => message && message.is_user !== true && message.is_user !== 'true')
    .slice(-limit)
    .reverse()
    .map(([id, message]) => {
      const raw = String(message.mes || message.text || '');
      const preview = raw.replace(/<[^>]*>/g, ' ')
        .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ').trim();
      return {
        id,
        floor: Number.isFinite(Number(id)) ? Number(id) + 1 : id,
        name: String(message.name || message.character_name || '角色回复'),
        preview: preview.slice(0, 100) || '（这条消息没有可预览的文本）',
      };
    });
}

/**
 * 注入独立悬浮球与楼层选择面板。
 * 悬浮球不属于任何聊天楼层，也不会改变消息文本容器的布局。
 */
function injectFloatingLauncher() {
  if (document.getElementById('bilingual-tts-floating-root')) return;
  const root = document.createElement('div');
  root.id = 'bilingual-tts-floating-root';
  root.innerHTML = `
    <div class="bilingual-tts-floor-picker" id="bilingual-tts-floor-picker" aria-hidden="true">
      <div class="bilingual-tts-picker-header">
        <span>选择要朗读的楼层</span>
        <button type="button" id="bilingual-tts-picker-close" aria-label="关闭楼层选择器" title="关闭">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="bilingual-tts-floor-list" id="bilingual-tts-floor-list"></div>
    </div>
    <button type="button" class="bilingual-tts-floating-ball" id="bilingual-tts-floating-ball" aria-label="选择朗读楼层" title="选择要朗读的楼层">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9v6h4l5 4V5l-5 4h-4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>
    </button>`;
  document.body.appendChild(root);

  const picker = root.querySelector('#bilingual-tts-floor-picker');
  const closePicker = () => {
    picker.classList.remove('open');
    picker.setAttribute('aria-hidden', 'true');
  };
  root.querySelector('#bilingual-tts-floating-ball').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (picker.classList.contains('open')) return closePicker();
    renderFloorPicker();
    picker.classList.add('open');
    picker.setAttribute('aria-hidden', 'false');
  });
  root.querySelector('#bilingual-tts-picker-close').addEventListener('click', closePicker);
  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) closePicker();
  });
}

/** 渲染最近的角色楼层；点击某项后仅处理选中的那一楼。 */
function renderFloorPicker() {
  const list = document.getElementById('bilingual-tts-floor-list');
  if (!list) return;
  list.replaceChildren();
  const messages = getSpeakableMessages(40);
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'bilingual-tts-picker-empty';
    empty.textContent = '当前聊天中没有可朗读的角色楼层';
    list.appendChild(empty);
    return;
  }
  messages.forEach((message) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'bilingual-tts-floor-option';
    option.dataset.messageId = message.id;
    const top = document.createElement('span');
    top.className = 'bilingual-tts-floor-option-top';
    const name = document.createElement('strong');
    name.textContent = message.name;
    const floor = document.createElement('small');
    floor.textContent = `第 ${message.floor} 楼`;
    top.append(name, floor);
    const preview = document.createElement('span');
    preview.className = 'bilingual-tts-floor-option-preview';
    preview.textContent = message.preview;
    option.append(top, preview);
    option.addEventListener('click', async () => {
      if (processingMessages.has(message.id)) {
        showToast('这一层正在处理中，请稍候', 'info');
        return;
      }
      const currentPicker = document.getElementById('bilingual-tts-floor-picker');
      currentPicker?.classList.remove('open');
      currentPicker?.setAttribute('aria-hidden', 'true');
      try {
        await processMessage(message.id);
      } catch (err) {
        console.error(`[${MODULE_NAME}] Manual floor selection error:`, err);
        logDiagnostic(`楼层 ${message.floor} 处理失败`, err.message || String(err), 'error');
        showToast(`该楼层处理失败：${err.message || err}`, 'error');
      }
    });
    list.appendChild(option);
  });
}

/** 注入独立的双语字幕播放器。 */
function injectSubtitleOverlay() {
  if (document.getElementById('bilingual-tts-player-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'bilingual-tts-player-overlay';
  overlay.className = 'bilingual-tts-overlay hidden';
  overlay.innerHTML = `
    <div class="bilingual-tts-player-card">
      <div class="bilingual-tts-player-header">
        <div class="bilingual-tts-speaker-tag">
          <span class="speaker-dot"></span>
          <span id="bilingual-tts-speaker-name">Character</span>
          <span class="bilingual-tts-queue-counter" id="bilingual-tts-queue-counter">1/1</span>
        </div>
        <div class="bilingual-tts-player-actions">
          <button id="bilingual-tts-prev-btn" title="上一句" aria-label="上一句"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M19 6l-9 6 9 6z"/></svg></button>
          <button id="bilingual-tts-pause-btn" title="暂停" aria-label="暂停"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg></button>
          <button id="bilingual-tts-next-btn" title="下一句" aria-label="下一句"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14M5 6l9 6-9 6z"/></svg></button>
          <button id="bilingual-tts-stop-btn" title="停止播放" aria-label="停止播放"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>
        </div>
      </div>
      <div class="bilingual-tts-subtitles">
        <p class="bilingual-tts-en" id="bilingual-tts-en-sub">English dialog line...</p>
        <p class="bilingual-tts-zh" id="bilingual-tts-zh-sub">中文台词翻译...</p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#bilingual-tts-stop-btn').addEventListener('click', stopAudioQueue);
  overlay.querySelector('#bilingual-tts-pause-btn').addEventListener('click', toggleAudioPause);
  overlay.querySelector('#bilingual-tts-next-btn').addEventListener('click', () => playNextInQueue());
  overlay.querySelector('#bilingual-tts-prev-btn').addEventListener('click', () => playPrevInQueue());
}

/**
 * 核心流程：处理单楼层消息
 */
export async function processMessage(messageId, triggerBtn = null) {
  const id = String(messageId);
  if (processingMessages.has(id)) {
    showToast('这一层已经在处理中，请勿重复点击', 'info');
    return;
  }
  processingMessages.add(id);
  try {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) throw new Error('未找到该消息楼层数据（可能聊天记录已刷新）');

    const rawText = message.mes || message.text || '';
    if (!rawText.trim()) throw new Error('本楼消息文本为空，无法提取');

    const settings = extension_settings[MODULE_NAME];
    const messageCacheKey = `${id}::${rawText}::${settings.speaker_filter || ''}`;
    let lines = processedMessageLines.get(messageCacheKey);
    if (lines?.length) {
      logDiagnostic(`楼层 ${id}`, '命中提取缓存，跳过重复 AI/API 提取');
      showToast('已使用本楼缓存台词，不重复请求提取 API', 'info');
    } else {
      if (settings.extract_mode === 'ai') {
        if (triggerBtn) triggerBtn.title = 'AI 正在提取台词…';
        try {
          lines = await extractWithAI(rawText, message.name || 'Character');
          if (!lines.length) throw new Error('AI 已返回结果，但没有提取到有效英文/中文台词');
          logDiagnostic(`楼层 ${id} · AI 提取`, `成功提取 ${lines.length} 句`);
        } catch (err) {
          logDiagnostic(`楼层 ${id} · AI 提取失败`, err.message || String(err), 'error');
          if (settings.fallback_to_regex) {
            showToast(`AI 提取失败，尝试正则兜底：${err.message}`, 'warning');
            lines = extractWithRegex(rawText, message.name || 'Character');
            if (!lines.length) throw new Error(`AI 提取失败且正则兜底无结果。原因：${err.message}`);
            logDiagnostic(`楼层 ${id} · 正则兜底`, `提取到 ${lines.length} 句`);
          } else {
            throw err;
          }
        }
      } else {
        if (triggerBtn) triggerBtn.title = '正则正在提取台词…';
        lines = extractWithRegex(rawText, message.name || 'Character');
        if (!lines.length) throw new Error('正则没有匹配到双语台词，请检查引号、括号翻译格式或正则规则');
        logDiagnostic(`楼层 ${id} · 正则提取`, `成功提取 ${lines.length} 句`);
      }

      const speakerFilter = normalizeSpeakerName(settings.speaker_filter);
      if (speakerFilter) {
        const extractedCount = lines.length;
        lines = lines.filter((line) => {
          const extractedSpeaker = String(line.character || '').trim();
          const isGenericSpeaker = !extractedSpeaker || /^(character|unknown|speaker|角色|未知)$/i.test(extractedSpeaker);
          const speakerName = isGenericSpeaker ? (message.name || extractedSpeaker) : extractedSpeaker;
          return speakerNameMatches(speakerName, speakerFilter);
        });
        if (!lines.length) throw new Error(`提取到 ${extractedCount} 句，但没有匹配指定角色“${settings.speaker_filter.trim()}”的台词`);
      }
      processedMessageLines.set(messageCacheKey, lines);
    }

    if (!lines?.length) throw new Error('没有可供朗读的台词');
    logDiagnostic(`楼层 ${id}`, `准备播放 ${lines.length} 句`);
    showToast(`成功提取 ${lines.length} 句台词，开始朗读`, 'success');
    enqueueLines(lines, messageId);
  } catch (err) {
    logDiagnostic(`楼层 ${id} 处理失败`, err.message || String(err), 'error');
    throw err;
  } finally {
    processingMessages.delete(id);
  }
}

/**
 * 模块一【模式 A】：廉价 AI 智能提取
 */
export async function extractWithAI(rawText, defaultCharName = 'Character') {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.ai_api_key) {
    throw new Error('请先在插件抽屉中配置 AI API Key');
  }

  const cleanBaseUrl = settings.ai_api_url.replace(/\/+$/, '');
  const endpoint = `${cleanBaseUrl}/chat/completions`;

  const messages = [
    { role: 'system', content: settings.ai_custom_prompt || DEFAULT_AI_PROMPT },
    { role: 'user', content: `角色名称: ${defaultCharName}\n文本内容:\n${rawText}` }
  ];

  const payload = {
    model: settings.ai_model || 'gpt-4o-mini',
    messages,
    temperature: 0.1,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.ai_api_key}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API 错误 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  let data;
  try { data = await response.json(); } catch (error) { throw new Error('AI API 返回的不是有效 JSON；请检查接口地址及服务商响应格式'); }
  if (data.error) throw new Error(`AI API 返回错误：${data.error.message || JSON.stringify(data.error).slice(0, 180)}`);
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(`AI API 未提取到文本内容（HTTP 请求成功，但 choices[0].message.content 为空）。响应字段：${Object.keys(data || {}).join(', ') || '无'}`);
  }

  // 清洗可能存在的 Markdown ```json 语法块
  const jsonStr = content.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      if (typeof parsed === 'object') {
        // 如果返回了形如 { dialogs: [...] }
        const key = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
        if (key) return parsed[key];
      }
      throw new Error('AI 返回结果非数组');
    }
    return parsed.map(item => ({
      character: item.character || defaultCharName,
      english: (item.english || '').trim(),
      chinese: (item.chinese || '').trim(),
    })).filter(item => item.english || item.chinese);
  } catch (err) {
    console.error(`[${MODULE_NAME}] JSON 解析失败:`, content);
    throw new Error(`台词 JSON 解析失败: ${err.message}`);
  }
}

/**
 * 模块一【模式 B】：正则纯提取（备用/省流模式）
 * 匹配引号内容，以及其紧接着括号中的中文内容，例如: "Hello." (你好。)
 */
export function extractWithRegex(rawText, defaultCharName = 'Character') {
  const lines = [];
  const settings = extension_settings[MODULE_NAME] || DEFAULT_SETTINGS;
  const pattern = settings.regex_pattern || DEFAULT_SETTINGS.regex_pattern;
  let regex;

  try {
    regex = new RegExp(pattern, 'g');
  } catch (error) {
    console.warn(`[${MODULE_NAME}] 自定义正则无效，改用内置默认规则:`, error);
    regex = new RegExp(DEFAULT_SETTINGS.regex_pattern, 'g');
  }

  let match;
  while ((match = regex.exec(rawText)) !== null) {
    const speech = String(match[1] || '').trim();
    // Group 2 是引号内部括号中的翻译；Group 3 是引号外部括号中的翻译。
    const translation = String(match[2] || match[3] || '').trim();

    // 没有匹配到翻译括号时跳过，避免把纯旁白或普通引号内容误当成双语台词。
    if (!speech || !translation) continue;

    // 仅接受确实含有中文的翻译，避免将普通英文括号误识别为中文翻译。
    if (!/[\u4e00-\u9fff]/.test(translation)) continue;

    lines.push({
      character: defaultCharName,
      english: speech,
      chinese: translation,
    });
  }

  return lines;
}

/**
 * 规范化角色名：忽略大小写、空格及常见姓名分隔符，便于输入部分名字筛选。
 */
function normalizeSpeakerName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s·•._-]/g, '');
}

/**
 * 支持完整名称或部分名称匹配，例如输入 Mortimer 可匹配 Mortimer Lasmodis。
 */
function speakerNameMatches(name, filter) {
  const normalizedName = normalizeSpeakerName(name);
  if (!normalizedName || !filter) return false;
  return normalizedName.includes(filter) || filter.includes(normalizedName);
}

/**
 * 模块二：MiniMax TTS 请求
 * 支持 MiniMax T2A v2 / Pro 接口
 */
export async function requestMiniMaxTTS(textToRead) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.minimax_api_key || !settings.minimax_group_id) {
    throw new Error('请在插件设置中配置 MiniMax API Key 与 Group ID');
  }

  const url = `https://api.minimax.chat/v1/t2a_v2?GroupId=${settings.minimax_group_id}`;

  const payload = {
    model: settings.minimax_model || 'speech-01-turbo',
    text: textToRead,
    stream: false,
    voice_setting: {
      voice_id: settings.minimax_voice_id || 'male-qn-qingse',
      speed: Number(settings.minimax_speed) || 1.0,
      vol: Number(settings.minimax_vol) || 1.0,
      pitch: Number(settings.minimax_pitch) || 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${settings.minimax_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MiniMax HTTP 错误 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  let data;
  try { data = await response.json(); } catch (error) { throw new Error('MiniMax 返回内容不是有效 JSON'); }
  if (data.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 [${data.base_resp.status_code}]: ${data.base_resp.status_msg}`);
  }

  // MiniMax 返回音频数据可能是 Hex 字符串或者 Base64，或者 audio_url
  const audioHex = data.data?.audio;
  const audioUrl = data.data?.audio_url;

  if (audioUrl) {
    return audioUrl;
  }

  if (audioHex) {
    return hexOrBase64ToAudioUrl(audioHex);
  }

  throw new Error('MiniMax 响应中未找到有效音频数据');
}

/**
 * Hex 编码或 Base64 转 Audio Blob Object URL
 */
function hexOrBase64ToAudioUrl(str) {
  // 检查是否为 Hex 字符 (只含 0-9a-fA-F)
  const isHex = /^[0-9a-fA-F]+$/.test(str.slice(0, 100));

  if (isHex) {
    const cleanHex = str.replace(/^0x/, '');
    const len = cleanHex.length;
    const bytes = new Uint8Array(len / 2);
    for (let i = 0; i < len; i += 2) {
      bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
    }
    const blob = new Blob([bytes], { type: 'audio/mp3' });
    return URL.createObjectURL(blob);
  } else {
    // 视为 Base64
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'audio/mp3' });
    return URL.createObjectURL(blob);
  }
}

/**
 * 将台词放入播放队列并启动顺序合成与播放
 */
export function enqueueLines(lines, messageId) {
  const settings = extension_settings[MODULE_NAME];

  // 构建待播项目
  const newItems = lines.map((line, idx) => {
    let speechText = '';
    if (settings.read_target === 'english') {
      speechText = line.english || line.chinese;
    } else if (settings.read_target === 'chinese') {
      speechText = line.chinese || line.english;
    } else {
      // 英文 + 中文双读
      speechText = `${line.english}。${line.chinese}`;
    }

    return {
      index: idx,
      character: line.character,
      english: line.english,
      chinese: line.chinese,
      speechText,
      audioUrl: null,
      status: 'pending', // 'pending' | 'synthesizing' | 'ready' | 'playing' | 'done' | 'error'
      error: null,
    };
  });

  // 停止当前正在播放的旧队列
  stopAudioQueue();

  playQueue.items = newItems;
  playQueue.currentIndex = -1;
  playQueue.activeMessageId = messageId;

  // 显示字幕浮层
  if (settings.show_subtitle) {
    const overlay = document.getElementById('bilingual-tts-player-overlay');
    if (overlay) overlay.classList.remove('hidden');
  }

  // 播放队列第一项
  playNextInQueue();
}

/**
 * 播放队列中的下一项
 */
export async function playNextInQueue() {
  if (playQueue.currentIndex + 1 >= playQueue.items.length) {
    console.log(`[${MODULE_NAME}] All dialogs finished playing.`);
    playQueue.isPlaying = false;
    updateSubtitleUI(null, '播放完毕');
    setTimeout(() => {
      const overlay = document.getElementById('bilingual-tts-player-overlay');
      if (overlay) overlay.classList.add('hidden');
    }, 2000);
    return;
  }

  playQueue.currentIndex += 1;
  const currentItem = playQueue.items[playQueue.currentIndex];
  playQueue.isPlaying = true;

  // 更新字幕 UI 为合成中状态
  updateSubtitleUI(currentItem, 'MiniMax 语音合成中...');

  try {
    currentItem.status = 'synthesizing';
    // 若未缓存音频 URL，发起合成请求
    if (!currentItem.audioUrl) {
      const cacheKey = `${extension_settings[MODULE_NAME].minimax_voice_id}|${extension_settings[MODULE_NAME].minimax_model}|${currentItem.speechText}`;
      currentItem.audioUrl = audioCache.get(cacheKey) || await requestMiniMaxTTS(currentItem.speechText);
      audioCache.set(cacheKey, currentItem.audioUrl);
    }

    currentItem.status = 'playing';
    updateSubtitleUI(currentItem, '正在播放');

    // 播放音频
    playQueue.audioElement.src = currentItem.audioUrl;
    await playQueue.audioElement.play();
  } catch (err) {
    console.error(`[${MODULE_NAME}] Playback error at item #${playQueue.currentIndex}:`, err);
    logDiagnostic('MiniMax 合成 / 音频播放失败', err.message || String(err), 'error');
    currentItem.status = 'error';
    currentItem.error = err.message;
    showToast(`台词合成失败: ${err.message}`, 'error');
    // 出错后自动尝试播放下一句
    setTimeout(() => playNextInQueue(), 1500);
  }
}

/**
 * 播放队列上一句
 */
export function playPrevInQueue() {
  if (playQueue.currentIndex > 0) {
    playQueue.currentIndex -= 2;
    playNextInQueue();
  }
}

/**
 * 音频播放结束回调
 */
function onAudioEnded() {
  const currentItem = playQueue.items[playQueue.currentIndex];
  if (currentItem) currentItem.status = 'done';

  const settings = extension_settings[MODULE_NAME];
  const delay = Number(settings.audio_delay_ms) || 300;

  setTimeout(() => {
    playNextInQueue();
  }, delay);
}

/**
 * 音频播放失败回调
 */
function onAudioError(e) {
  console.error(`[${MODULE_NAME}] HTML5 Audio error:`, e);
  logDiagnostic('浏览器音频播放失败', '音频元素触发 error 事件；请检查返回音频、网络或浏览器播放权限', 'error');
  showToast('音频播放异常，跳到下一句', 'warning');
  setTimeout(() => playNextInQueue(), 1000);
}

/**
 * 暂停 / 继续播放
 */
export function toggleAudioPause() {
  if (!playQueue.audioElement) return;

  const pauseBtn = document.getElementById('bilingual-tts-pause-btn');
  if (playQueue.audioElement.paused) {
    playQueue.audioElement.play();
    if (pauseBtn) { pauseBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>'; pauseBtn.title = '暂停'; pauseBtn.setAttribute('aria-label', '暂停'); }
  } else {
    playQueue.audioElement.pause();
    if (pauseBtn) { pauseBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>'; pauseBtn.title = '继续'; pauseBtn.setAttribute('aria-label', '继续'); }
  }
}

/**
 * 停止当前播放并清空队列
 */
export function stopAudioQueue() {
  if (playQueue.audioElement) {
    playQueue.audioElement.pause();
    playQueue.audioElement.currentTime = 0;
  }
  playQueue.isPlaying = false;
  playQueue.items = [];
  playQueue.currentIndex = -1;

  const overlay = document.getElementById('bilingual-tts-player-overlay');
  if (overlay) overlay.classList.add('hidden');
}

/**
 * 更新悬浮字幕与控制面板信息
 */
function updateSubtitleUI(item, statusText = '') {
  const overlay = document.getElementById('bilingual-tts-player-overlay');
  if (!overlay) return;

  if (!item) {
    const enSub = document.getElementById('bilingual-tts-en-sub');
    const zhSub = document.getElementById('bilingual-tts-zh-sub');
    if (enSub) enSub.textContent = '';
    if (zhSub) zhSub.textContent = statusText;
    return;
  }

  const speakerName = document.getElementById('bilingual-tts-speaker-name');
  const counter = document.getElementById('bilingual-tts-queue-counter');
  const enSub = document.getElementById('bilingual-tts-en-sub');
  const zhSub = document.getElementById('bilingual-tts-zh-sub');

  if (speakerName) speakerName.textContent = item.character || 'Character';
  if (counter) counter.textContent = `${item.index + 1}/${playQueue.items.length}`;
  if (enSub) enSub.textContent = item.english || '(No English Speech)';
  if (zhSub) zhSub.textContent = item.chinese || statusText;
}

/**
 * 右侧抽屉设置页面初始化
 */
async function initSettingsUI() {
  let html = '';
  try {
    html = await renderExtensionTemplateAsync(`third-party/${EXTENSION_DIR}`, 'settings');
  } catch (e) {
    console.warn(`[${MODULE_NAME}] Template load failed with third-party/${EXTENSION_DIR}, trying fallback:`, e);
    try {
      html = await renderExtensionTemplateAsync(EXTENSION_DIR, 'settings');
    } catch (e2) {
      console.error(`[${MODULE_NAME}] Could not load settings template:`, e2);
    }
  }

  if (!html) {
    console.error(`[${MODULE_NAME}] Settings template is empty; settings panel was not mounted.`);
    return;
  }

  const mount = () => {
    // SillyTavern 当前扩展设置模板的标准挂载点是 #extensions_settings2
    const container = document.querySelector('#extensions_settings2')
      || document.querySelector('#extensions_settings');
    if (!container) return false;
    if (document.getElementById('bilingual-tts-extension-settings-wrapper')) return true;

    const wrapper = document.createElement('div');
    wrapper.id = 'bilingual-tts-extension-settings-wrapper';
    wrapper.innerHTML = html;
    container.appendChild(wrapper);
    bindSettingsEvents();
    return true;
  };

  if (mount()) return;

  // 设置抽屉稍后才创建时，等它出现再挂载
  const observer = new MutationObserver(() => {
    if (mount()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 15000);
}

/**
 * 展开/收起酒馆右侧抽屉设置
 */
export function toggleDrawerSettings() {
  const extensionsBtn = document.querySelector(
    '#extensions_button, #nav-toggle-extensions, [data-drawer="extensions"]'
  );
  const settingsPanel = document.querySelector('#extensions_settings2')
    || document.querySelector('#extensions_settings');
  const panelVisible = settingsPanel && settingsPanel.getClientRects().length > 0;

  if (!panelVisible && extensionsBtn) extensionsBtn.click();

  // 等抽屉动画完成后，将插件设置项滚动到可视区域
  setTimeout(() => {
    const wrapper = document.getElementById('bilingual-tts-extension-settings-wrapper');
    if (!wrapper) return;
    const content = wrapper.querySelector('.inline-drawer-content');
    const toggle = wrapper.querySelector('.inline-drawer-toggle');
    if (content && toggle && !content.classList.contains('open')) toggle.click();
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 350);

  if (!extensionsBtn && !settingsPanel) {
    showToast('暂时找不到酒馆扩展设置面板，请刷新页面后重试', 'warning');
  }
}

/**
 * 绑定设置页面的输入控件与持久化存储
 */
function bindSettingsEvents() {
  const settings = extension_settings[MODULE_NAME];
  renderDiagnostics();

  const bindInput = (id, key, isCheckbox = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (isCheckbox) {
      el.checked = !!settings[key];
      el.addEventListener('change', () => {
        settings[key] = el.checked;
        saveSettingsDebounced();
        setSaveStatus('已自动保存');
      });
    } else {
      el.value = settings[key] ?? '';
      const updateValue = () => {
        settings[key] = el.type === 'number' ? Number(el.value) : el.value;
        saveSettingsDebounced();
        setSaveStatus('已自动保存');
      };
      el.addEventListener('input', updateValue);
      el.addEventListener('change', updateValue);
    }
  };

  bindInput('bilingual-enabled', 'enabled', true);
  bindInput('bilingual-auto-play', 'auto_play', true);
  bindInput('bilingual-extract-mode', 'extract_mode');
  bindInput('bilingual-ai-url', 'ai_api_url');
  bindInput('bilingual-ai-key', 'ai_api_key');
  bindInput('bilingual-ai-model', 'ai_model');
  bindInput('bilingual-ai-prompt', 'ai_custom_prompt');
  bindInput('bilingual-fallback-regex', 'fallback_to_regex', true);
  bindInput('bilingual-regex-pattern', 'regex_pattern');
  bindInput('bilingual-minimax-key', 'minimax_api_key');
  bindInput('bilingual-minimax-group', 'minimax_group_id');
  bindInput('bilingual-minimax-model', 'minimax_model');
  bindInput('bilingual-minimax-voice', 'minimax_voice_id');
  bindInput('bilingual-minimax-speed', 'minimax_speed');
  bindInput('bilingual-minimax-vol', 'minimax_vol');
  bindInput('bilingual-read-target', 'read_target');
  bindInput('bilingual-speaker-filter', 'speaker_filter');
  bindInput('bilingual-show-subtitle', 'show_subtitle', true);

  const saveBtn = document.getElementById('bilingual-save-settings');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    // 强制从当前表单再收集一次，避免输入框尚未触发 change/input 时漏存。
    document.querySelectorAll('#bilingual-tts-extension-settings-wrapper [id^=\"bilingual-\"]').forEach((el) => {
      const key = ({
        'bilingual-enabled':'enabled','bilingual-auto-play':'auto_play','bilingual-extract-mode':'extract_mode',
        'bilingual-ai-url':'ai_api_url','bilingual-ai-key':'ai_api_key','bilingual-ai-model':'ai_model','bilingual-ai-prompt':'ai_custom_prompt',
        'bilingual-fallback-regex':'fallback_to_regex','bilingual-regex-pattern':'regex_pattern','bilingual-minimax-key':'minimax_api_key',
        'bilingual-minimax-group':'minimax_group_id','bilingual-minimax-model':'minimax_model','bilingual-minimax-voice':'minimax_voice_id',
        'bilingual-minimax-speed':'minimax_speed','bilingual-minimax-vol':'minimax_vol','bilingual-read-target':'read_target',
        'bilingual-speaker-filter':'speaker_filter','bilingual-show-subtitle':'show_subtitle'
      })[el.id];
      if (key) settings[key] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
    });
    saveSettingsDebounced();
    setSaveStatus('配置已保存；重新打开酒馆后会自动读取');
    showToast('插件配置已保存', 'success');
    logDiagnostic('配置保存', '用户手动保存全部设置');
  });
}

function setSaveStatus(message) {
  const el = document.getElementById('bilingual-save-status');
  if (el) el.textContent = message;
}

function renderDiagnostics() {
  const list = document.getElementById('bilingual-diagnostics');
  if (!list) return;
  if (!diagnosticEntries.length) { list.innerHTML = '<div class=\"bilingual-log-empty\">暂无运行记录</div>'; return; }
  list.innerHTML = diagnosticEntries.map((item) => `<div class=\"bilingual-log-entry ${item.level}\"><time>${escapeHtml(item.time)}</time><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.detail)}</span></div>`).join('');
}

function logDiagnostic(title, detail, level = 'info') {
  const entry = { time: new Date().toLocaleTimeString(), title, detail: String(detail || ''), level };
  diagnosticEntries.unshift(entry);
  if (diagnosticEntries.length > 30) diagnosticEntries.length = 30;
  console[level === 'error' ? 'error' : 'log'](`[${MODULE_NAME}] ${title}: ${detail}`);
  renderDiagnostics();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
}

/**
 * 简易 Toast 通知 (兼容酒馆 toastr 或自定义简易通知)
 */
function showToast(message, type = 'info') {
  if (window.toastr && typeof window.toastr[type] === 'function') {
    window.toastr[type](message, '双语台词 TTS');
    return;
  }
  console.log(`[${MODULE_NAME}][${type.toUpperCase()}] ${message}`);
}
