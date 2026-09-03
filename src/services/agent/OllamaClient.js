'use strict';

/** Back-compat: AgentService still requires OllamaClient. Implementation is LlmClient. */
module.exports = require('../llm/LlmClient');
