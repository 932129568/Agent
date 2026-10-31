/* ================= 确定性 chat 请求构造与 400 降级 ================= */
function buildChatRequestBody(options) {
  const body = {
    model: options.model,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: options.temperature,
    top_p: options.topP,
    max_tokens: options.maxTokens,
  };
  if (options.effort === 'off') body.thinking = { type: 'disabled' };
  else body.reasoning_effort = options.effort;
  if (!options.glm) {
    delete body.thinking;
    delete body.reasoning_effort;
  }
  if (options.tools && options.tools.length > 0) body.tools = options.tools;
  return body;
}

function degradeChatBodyFor400(body, errorText) {
  if (body.thinking) {
    delete body.thinking;
    delete body.reasoning_effort;
    return 'thinking';
  }
  if (body.tools && /does not support tools|tools?\s*(are|is)?\s*not\s*(supported|enabled|available)|tool_choice|tool_calls?.*(unsupported|invalid)/i.test(errorText)) {
    delete body.tools;
    return 'tools';
  }
  return null;
}
