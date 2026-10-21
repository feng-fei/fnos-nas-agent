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
