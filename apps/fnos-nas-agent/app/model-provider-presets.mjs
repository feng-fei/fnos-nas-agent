const PRESETS = [
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "填写账户中可用的模型 ID",
    description: "OpenAI 官方 Chat Completions 接口",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat"
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    modelPlaceholder: "deepseek-flash 或账户中可用的模型 ID",
    description: "DeepSeek 官方 OpenAI 兼容接口",
    docsUrl: "https://api-docs.deepseek.com/api/create-chat-completion"
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    modelPlaceholder: "填写硅基流动控制台中的模型 ID",
    description: "兼容 OpenAI 的模型聚合服务",
    docsUrl: "https://docs.siliconflow.cn/docs/api/chat-completions-post"
  },
  {
    id: "dashscope-beijing",
    name: "阿里云百炼（北京共享域名）",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    modelPlaceholder: "例如 qwen-plus；请以账号可用模型为准",
    description: "百炼 OpenAI 兼容接口；工作空间专属域名也可手动填写",
    docsUrl: "https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope"
  },
  {
    id: "moonshot",
    name: "月之暗面 Moonshot AI",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    modelPlaceholder: "填写 Moonshot 控制台中可用的模型 ID",
    description: "Moonshot AI 官方 OpenAI 兼容接口",
    docsUrl: "https://platform.moonshot.cn/docs/api/chat"
  },
  {
    id: "zhipu",
    name: "智谱 AI BigModel",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    modelPlaceholder: "填写 BigModel 控制台中可用的模型 ID",
    description: "智谱 AI 官方 OpenAI 兼容接口",
    docsUrl: "https://open.bigmodel.cn/dev/api"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    modelPlaceholder: "例如 openai/gpt-4.1-mini；以账户可用列表为准",
    description: "多模型聚合服务，模型 ID 通常包含提供商前缀",
    docsUrl: "https://openrouter.ai/docs/api-reference/overview"
  },
  {
    id: "ollama-local",
    name: "本机 Ollama（仅回环地址）",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    modelPlaceholder: "填写已通过 ollama list 确认的模型名称",
    description: "本机 Ollama OpenAI 兼容接口；仅允许 localhost/127.0.0.1/::1 的 HTTP",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md"
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容接口",
    endpoint: "",
    modelPlaceholder: "填写服务商提供的模型 ID",
    description: "支持自建或其他兼容 Chat Completions 的服务",
    docsUrl: ""
  }
];

export function listModelProviderPresets() {
  return PRESETS.map(item => ({ ...item }));
}
