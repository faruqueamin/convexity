'use strict';

/**
 * Pluggable LLM client.
 *
 * Convexity's hosted desk uses an Ollama Cloud custom model. You can point
 * this at any model:
 *   - Ollama local or cloud  (VOL10S_LLM_PROVIDER=ollama)
 *   - OpenAI-compatible       (VOL10S_LLM_PROVIDER=openai)
 *
 * Same interface either way: chat(messages) → { content, toolCalls }.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

class LlmClient {
  constructor({ baseUrl, model, apiKey, provider, log, timeoutMs } = {}) {
    this.provider = String(provider || env('VOL10S_LLM_PROVIDER', 'ollama')).toLowerCase();
    if (this.provider === 'openai-compat') this.provider = 'openai';
    this.baseUrl = String(
      baseUrl
      || env('VOL10S_LLM_BASE_URL')
      || env('VOL10S_OLLAMA_URL')
      || (this.provider === 'openai' ? 'https://api.openai.com' : 'http://127.0.0.1:11434'),
    ).replace(/\/+$/, '');
    this.model = model
      || env('VOL10S_LLM_MODEL')
      || env('VOL10S_OLLAMA_MODEL')
      || 'llama3.1';
    this.apiKey = apiKey || env('VOL10S_LLM_API_KEY') || env('OLLAMA_API_KEY') || '';
    this.log = log || console;
    this.timeoutMs = parseInt(timeoutMs || '120000', 10);
  }

  _request(method, pathname, payload) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    const lib = url.protocol === 'https:' ? https : http;
    const body = payload == null ? null : JSON.stringify(payload);
    const headers = { Accept: 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return new Promise((resolve, reject) => {
      const req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: this.timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`LLM ${res.statusCode}: ${data.slice(0, 240)}`));
            return;
          }
          try { resolve(data ? JSON.parse(data) : {}); } catch (err) {
            reject(new Error(`LLM bad JSON: ${err.message}`));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async chat(messages) {
    if (this.provider === 'openai') return this._chatOpenAi(messages);
    return this._chatOllama(messages);
  }

  async _chatOllama(messages) {
    const res = await this._request('POST', '/api/chat', {
      model: this.model,
      stream: false,
      messages,
    });
    const msg = res.message || {};
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc) => ({
          name: tc?.function?.name,
          args: tc?.function?.arguments && typeof tc.function.arguments === 'object' ? tc.function.arguments : {},
        })).filter((tc) => tc.name)
      : [];
    return { content: String(msg.content || ''), toolCalls };
  }

  async _chatOpenAi(messages) {
    const res = await this._request('POST', '/v1/chat/completions', {
      model: this.model,
      messages,
      temperature: 0.2,
    });
    const choice = (res.choices && res.choices[0]) || {};
    const msg = choice.message || {};
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc) => ({
          name: tc?.function?.name,
          args: (() => {
            try { return typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); }
            catch (_) { return {}; }
          })(),
        })).filter((tc) => tc.name)
      : [];
    return { content: String(msg.content || ''), toolCalls };
  }

  async ping() {
    try {
      if (this.provider === 'openai') {
        const res = await this._request('GET', '/v1/models');
        const models = (res.data || []).map((m) => m.id);
        return { ok: true, provider: this.provider, model: this.model, models, modelLoaded: models.includes(this.model) || models.length > 0 };
      }
      const res = await this._request('GET', '/api/tags');
      const models = (res.models || []).map((m) => m.name);
      return { ok: true, provider: this.provider, model: this.model, models, modelLoaded: models.includes(this.model) };
    } catch (err) {
      return { ok: false, error: err.message, provider: this.provider, model: this.model, models: [], modelLoaded: false };
    }
  }
}

module.exports = LlmClient;
